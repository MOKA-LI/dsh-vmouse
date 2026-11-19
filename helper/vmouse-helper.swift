// dsh-vmouse helper — macOS virtual mouse / keyboard, background-safe.
//
// Design goals:
//   1. NEVER move the physical cursor, NEVER steal frontmost focus.
//   2. Prefer Accessibility (AX) element actions (no coordinates, cheapest tokens).
//   3. Fall back to CGEventPostToPid() — events are queued *to the target process*
//      so the hardware cursor stays where the user left it.
//   4. Line-delimited JSON over stdio; actions can reference element refs from a
//      previous `tree` call (snapshot cache lives in this long-lived process).
//
// Commands: ping, perm, apps, tree, click, type, key, scroll, shot

import Foundation
import Cocoa
import ApplicationServices

@_silgen_name("CGEventPostToPid")
func CGEventPostToPid(_ pid: pid_t, _ event: CGEvent)

// MARK: - JSON IO

func emit(_ obj: [String: Any]) {
    var o = obj
    if o["ok"] == nil { o["ok"] = true }
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: []),
          var s = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write("{\"ok\":false,\"error\":\"encode\"}\n".data(using: .utf8)!)
        return
    }
    s += "\n"
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
}

func fail(_ code: String, _ msg: String, _ hint: String? = nil) {
    var o: [String: Any] = ["ok": false, "error": code, "message": msg]
    if let hint { o["hint"] = hint }
    emit(o)
}

let args = CommandLine.arguments

// MARK: - AX helpers

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return r == .success ? v : nil
}

func axStr(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = axAttr(el, name) else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() { return v as? String }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return "\(v)" }
    return nil
}

func axPoint(_ el: AXUIElement, _ name: String) -> CGPoint? {
    guard let v = axAttr(el, name), CFGetTypeID(v) == AXValueGetTypeID(),
          AXValueGetType(v as! AXValue) == .cgPoint else { return nil }
    var p = CGPoint.zero
    AXValueGetValue(v as! AXValue, .cgPoint, &p)
    return p
}

func axSize(_ el: AXUIElement, _ name: String) -> CGSize? {
    guard let v = axAttr(el, name), CFGetTypeID(v) == AXValueGetTypeID(),
          AXValueGetType(v as! AXValue) == .cgSize else { return nil }
    var s = CGSize.zero
    AXValueGetValue(v as! AXValue, .cgSize, &s)
    return s
}

func shortRole(_ role: String) -> String {
    var r = role
    if r.hasPrefix("AX") { r = String(r.dropFirst(2)) }
    return r.lowercased()
}

/// Accessibility custom actions arrive as long pseudo-strings
/// ("name:…\ntarget:0x0\nselector:…") that only burn tokens, so keep the
/// standard ones only.
let standardActions: Set<String> = [
    "press", "showmenu", "pick", "confirm", "cancel", "increment", "decrement",
    "setvalue", "scrolltovisible", "raise", "edit", "open", "accept", "delete",
    "showdefaultui", "showalternateui", "showhelp",
    "scrollupbypage", "scrolldownbypage", "scrollleftbypage", "scrollrightbypage",
]

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success,
          let arr = names as? [String] else { return [] }
    return arr.filter { !$0.contains("\n") && standardActions.contains(shortRole($0)) }
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func axWindows(_ pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    if let w = axAttr(app, kAXWindowsAttribute) as? [AXUIElement] { return w }
    if let w = axAttr(app, kAXFocusedWindowAttribute) {
        return [w as! AXUIElement]
    }
    return []
}

func windowNumber(_ win: AXUIElement) -> Int? {
    guard let v = axAttr(win, "AXWindowNumber"),
          CFGetTypeID(v) == CFNumberGetTypeID() else { return nil }
    return (v as! NSNumber).intValue
}

// MARK: - process / window listing

func runningApps() -> [(pid: pid_t, name: String, bundle: String)] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited && !$0.isTerminated }
        .map { ($0.processIdentifier, $0.localizedName ?? "?", $0.bundleIdentifier ?? "") }
}

struct WinInfo {
    let id: Int
    let pid: pid_t
    let title: String
    let bounds: CGRect
    let layer: Int
}

func cgWindows(pid: pid_t? = nil) -> [WinInfo] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [WinInfo] = []
    for w in raw {
        let owner = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        if let pid, owner != pid { continue }
        let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if layer != 0 { continue }
        let number = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
        let title = (w[kCGWindowName as String] as? String) ?? ""
        guard let bd = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let b = CGRect(x: bd["X"] as? Double ?? 0, y: bd["Y"] as? Double ?? 0,
                       width: bd["Width"] as? Double ?? 0, height: bd["Height"] as? Double ?? 0)
        if b.width < 40 || b.height < 40 { continue }
        out.append(WinInfo(id: number, pid: owner, title: title, bounds: b, layer: layer))
    }
    return out
}

/// Resolve the AX window the caller means: by window number if given, else first titled window.
func resolveWindow(pid: pid_t, windowId: Int?) -> AXUIElement? {
    let wins = axWindows(pid)
    if let windowId, !wins.isEmpty {
        for w in wins where windowNumber(w) == windowId { return w }
    }
    if let first = wins.first { return first }
    return nil
}

// MARK: - snapshot cache (ref -> AXUIElement)

struct Snapshot {
    let pid: pid_t
    var refs: [String: AXUIElement] = [:]
    var windowId: Int?
    var created: Date = Date()
}

var snapshots: [String: Snapshot] = [:]
var snapshotSeq = 0
var latestSnapshot: String?

func makeSnapshot(_ pid: pid_t, _ win: AXUIElement?, windowId: Int?) -> String {
    snapshotSeq += 1
    let id = "s\(snapshotSeq)"
    var s = Snapshot(pid: pid, windowId: windowId)
    if let win { s.refs = [:] }
    snapshots[id] = s
    latestSnapshot = id
    // keep the 4 most recent snapshots only
    if snapshots.count > 4 {
        let keys = snapshots.keys.sorted { a, b in
            (Int(a.dropFirst()) ?? 0) < (Int(b.dropFirst()) ?? 0)
        }
        for k in keys.prefix(snapshots.count - 4) { snapshots.removeValue(forKey: k) }
        if let cur = latestSnapshot, snapshots[cur] == nil { latestSnapshot = keys.last }
    }
    return id
}

func snapshot(_ id: String?) -> Snapshot? {
    let key = id ?? latestSnapshot
    guard let key else { return nil }
    return snapshots[key]
}

// MARK: - role cleanup

func decodeText(_ el: AXUIElement) -> String? {
    guard let v = axAttr(el, kAXValueAttribute) else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() { return v as? String }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return "\(v)" }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return ((v as! NSNumber).boolValue) ? "true" : "false" }
    if CFGetTypeID(v) == CFArrayGetTypeID() { return nil }
    return nil
}

// MARK: - command: tree

func buildTree(pid: pid_t, windowId: Int?, max: Int, interactiveOnly: Bool,
               maxDepth: Int, maxText: Int, filter: String?, snapId: String) -> [[String: Any]] {
    let win = resolveWindow(pid: pid, windowId: windowId)
    guard let win else { return [] }
    var nodes: [[String: Any]] = []
    var refIdx = 0
    var regex: NSRegularExpression? = filter.flatMap { try? NSRegularExpression(pattern: $0, options: .caseInsensitive) }

    func textMatch(_ s: String) -> Bool {
        guard let regex else { return true }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return regex.firstMatch(in: s, options: [], range: range) != nil
    }

    func walk(_ el: AXUIElement, _ depth: Int) {
        guard nodes.count < max, depth <= maxDepth else { return }
        let role = shortRole((axAttr(el, kAXRoleAttribute) as? String) ?? "")
        let subrole = shortRole((axAttr(el, kAXSubroleAttribute) as? String) ?? "")
        let title = axStr(el, kAXTitleAttribute) ?? axStr(el, kAXDescriptionAttribute) ?? ""
        let value = decodeText(el) ?? ""
        let actions = axActions(el)
        let isInput = ["textfield", "textarea", "combobox", "searchfield", "securetextfield"].contains(role)
        let isText = ["statictext", "text", "heading", "link", "weblink"].contains(role)
        let hasValue = !value.isEmpty

        // "showmenu"/"scrolltovisible" are on nearly every node; they carry no intent.
        let meatyActions = actions.filter {
            let a = shortRole($0)
            return a != "showmenu" && a != "scrolltovisible"
        }
        var keep = true
        if interactiveOnly {
            keep = !meatyActions.isEmpty || isInput
            if !keep && isText && hasValue { keep = true }
            // structural containers with no readable text are pure noise
            if !keep && !hasValue && title.isEmpty { keep = false }
        }

        var entry: [String: Any] = ["role": role]
        if !subrole.isEmpty { entry["subrole"] = subrole }

        let label = title.isEmpty ? value : title
        if keep || title.isEmpty == false {
            // filter applies to human-readable text
            if let filter, !textMatch(label + " " + value) { keep = false }
        }

        if keep {
            refIdx += 1
            let ref = "e\(refIdx)"
            snapshots[snapId]?.refs[ref] = el
            entry["ref"] = ref
            if !title.isEmpty { entry["title"] = String(title.prefix(maxText)) }
            if hasValue { entry["value"] = String(value.prefix(maxText)) }
            if let p = axPoint(el, kAXPositionAttribute), let s = axSize(el, kAXSizeAttribute) {
                entry["rect"] = [Int(p.x), Int(p.y), Int(s.width), Int(s.height)]
            }
            if !actions.isEmpty { entry["actions"] = actions.map { shortRole($0) } }
            if let e = axAttr(el, kAXEnabledAttribute) as? Bool, !e { entry["disabled"] = true }
            if role == "textfield" || role == "textarea" || role == "combobox" { entry["editable"] = true }
            nodes.append(entry)
        }

        for child in axChildren(el) where nodes.count < max {
            walk(child, depth + 1)
        }
    }

    walk(win, 0)
    return nodes
}

// MARK: - command: pointer posts

func postMouse(pid: pid_t, point: CGPoint, button: String, clicks: Int, modifiers: [String]) {
    let right = button == "right"
    let flags = modifierFlags(modifiers)
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let btn: CGMouseButton = right ? .right : .left
    for n in 1...max(1, clicks) {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: btn)!
        down.flags = flags
        down.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        CGEventPostToPid(pid, down)
        usleep(12000)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: btn)!
        up.flags = flags
        up.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        CGEventPostToPid(pid, up)
        usleep(12000)
    }
}

func modifierFlags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m.lowercased() {
        case "cmd", "command", "meta": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "ctrl", "control": f.insert(.maskControl)
        case "opt", "alt", "option": f.insert(.maskAlternate)
        case "fn": f.insert(.maskSecondaryFn)
        default: break
        }
    }
    return f
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "forwarddelete": 117, "del": 117,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
]

func postKey(pid: pid_t, code: CGKeyCode, flags: CGEventFlags) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
    down.flags = flags
    CGEventPostToPid(pid, down)
    usleep(8000)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
    up.flags = flags
    CGEventPostToPid(pid, up)
    usleep(8000)
}

func postText(pid: pid_t, text: String) {
    // typed as unicode so CJK and emoji survive without IME
    for ch in text {
        let s = String(ch)
        var utf16 = Array(s.utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        CGEventPostToPid(pid, down)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        CGEventPostToPid(pid, up)
        usleep(6000)
    }
}

// MARK: - command dispatch

func handle(_ req: [String: Any]) {
    let cmd = (req["cmd"] as? String) ?? ""
    let pid = pid_t((req["pid"] as? NSNumber)?.int32Value ?? 0)
    let windowId = (req["windowId"] as? NSNumber)?.intValue
    let trusted = AXIsProcessTrusted()

    switch cmd {
    case "ping":
        emit(["ok": true, "helper": "vmouse", "version": "0.1.0", "axTrusted": trusted,
              "cursor": "\(NSEvent.mouseLocation)", "pid": getpid(),
              "frontPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0])

    case "perm":
        emit(["ok": true, "axTrusted": trusted,
              "hint": trusted ? "ready" : "Grant Accessibility to DeepSeek Harness in System Settings > Privacy & Security > Accessibility"])

    case "apps":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted", "System Settings > Privacy & Security > Accessibility > enable DeepSeek Harness"); return }
        let includeWindows = (req["windows"] as? Bool) ?? true
        var out: [[String: Any]] = []
        for app in runningApps() {
            if app.pid == 0 { continue }
            var item: [String: Any] = ["pid": app.pid, "name": app.name]
            if !app.bundle.isEmpty { item["bundle"] = app.bundle }
            if includeWindows {
                let wins = cgWindows(pid: app.pid).map { w -> [String: Any] in
                    ["windowId": w.id, "title": w.title,
                     "rect": [Int(w.bounds.origin.x), Int(w.bounds.origin.y), Int(w.bounds.width), Int(w.bounds.height)]]
                }
                if wins.isEmpty { continue } // skip apps without on-screen windows
                item["windows"] = wins
            }
            out.append(item)
        }
        emit(["ok": true, "count": out.count, "apps": out])

    case "tree":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted"); return }
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        let maxN = (req["max"] as? NSNumber)?.intValue ?? 120
        let depth = (req["depth"] as? NSNumber)?.intValue ?? 14
        let maxText = (req["maxText"] as? NSNumber)?.intValue ?? 80
        let interactive = (req["interactiveOnly"] as? Bool) ?? true
        let filter = req["filter"] as? String
        guard let win = resolveWindow(pid: pid, windowId: windowId) else {
            fail("NO_WINDOW", "no accessible window for pid \(pid)", "call apps to list windows"); return
        }
        let sid = makeSnapshot(pid, win, windowId: windowId)
        snapshots[sid]?.refs = [:]
        let nodes = buildTree(pid: pid, windowId: windowId, max: maxN, interactiveOnly: interactive,
                              maxDepth: depth, maxText: maxText, filter: filter, snapId: sid)
        var snapped: [String: Any] = ["snapshot": sid, "pid": pid, "count": nodes.count, "nodes": nodes]
        if let windowId { snapped["windowId"] = windowId }
        let title = (axAttr(win, kAXTitleAttribute) as? String) ?? ""
        snapped["window"] = title
        var treeOut: [String: Any] = ["ok": true]
        treeOut.merge(snapped) { _, b in b }
        emit(treeOut)

    case "click":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted"); return }
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        // Coordinate click is allowed without a ref (fallback for canvas / no AX tree).
        if req["ref"] == nil, let x = (req["x"] as? NSNumber)?.doubleValue,
           let y = (req["y"] as? NSNumber)?.doubleValue {
            let button = (req["button"] as? String) ?? "left"
            let clickCount = (req["clicks"] as? NSNumber)?.intValue ?? 1
            postMouse(pid: pid, point: CGPoint(x: x, y: y), button: button,
                      clicks: clickCount, modifiers: (req["modifiers"] as? [String]) ?? [])
            emit(["ok": true, "how": "post-to-pid", "at": [Int(x), Int(y)], "button": button,
                  "clicks": clickCount, "cursorMoved": false])
            return
        }
        guard let snap = snapshot(req["snapshot"] as? String) else {
            fail("NO_SNAPSHOT", "call tree first", "element refs are only valid for the snapshot that produced them"); return
        }
        guard let ref = req["ref"] as? String, let el = snap.refs[ref] else {
            fail("BAD_REF", "unknown element ref \(req["ref"] ?? "")", "call tree again"); return
        }
        let actions = axActions(el)
        let role = shortRole((axAttr(el, kAXRoleAttribute) as? String) ?? "")
        let clickCount = (req["clicks"] as? NSNumber)?.intValue ?? 1
        // Double click means "open/activate", which AX press does not express.
        if clickCount == 1 && actions.contains(kAXPressAction) {
            let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if r == .success { emit(["ok": true, "how": "ax-press", "ref": ref, "cursorMoved": false]); return }
        }
        guard let p = axPoint(el, kAXPositionAttribute), let sz = axSize(el, kAXSizeAttribute) else {
            fail("NO_RECT", "element has no position; use tree rect + coordinate click"); return
        }
        let center = CGPoint(x: p.x + sz.width / 2, y: p.y + sz.height / 2)
        let button = (req["button"] as? String) ?? "left"
        postMouse(pid: pid, point: center, button: button, clicks: clickCount, modifiers: (req["modifiers"] as? [String]) ?? [])
        emit(["ok": true, "how": "post-to-pid", "ref": ref, "role": role, "at": [Int(center.x), Int(center.y)],
              "button": button, "clicks": clickCount, "cursorMoved": false])

    case "type":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted"); return }
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        let text = (req["text"] as? String) ?? ""
        guard !text.isEmpty else { fail("BAD_TEXT", "text required"); return }
        if let ref = req["ref"] as? String, let snap = snapshot(req["snapshot"] as? String), let el = snap.refs[ref] {
            // Value-style fast path: no key events, no focus change
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
            if settable.boolValue {
                let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
                if r == .success {
                    emit(["ok": true, "how": "ax-set-value", "ref": ref, "chars": text.count, "cursorMoved": false]); return
                }
            }
            AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(20000)
        }
        postText(pid: pid, text: text)
        emit(["ok": true, "how": "post-to-pid", "chars": text.count, "cursorMoved": false])

    case "key":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted"); return }
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        let combo = ((req["keys"] as? String) ?? "").lowercased()
        guard !combo.isEmpty else { fail("BAD_KEYS", "keys required, e.g. cmd+shift+z"); return }
        var parts = combo.split(separator: "+").map(String.init)
        var flags: CGEventFlags = []
        var keyName = ""
        for p in parts {
            switch p {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "ctrl", "control": flags.insert(.maskControl)
            case "opt", "alt", "option": flags.insert(.maskAlternate)
            default: keyName = p
            }
        }
        guard let code = keyCodes[keyName] else {
            fail("UNKNOWN_KEY", "unknown key '\(keyName)'", "supported: letters, digits, return, tab, space, delete, esc, arrows, f1-f12, punctuation"); return
        }
        postKey(pid: pid, code: code, flags: flags)
        emit(["ok": true, "how": "post-to-pid", "keys": combo, "cursorMoved": false])

    case "sel":
        guard let snap = snapshot(req["snapshot"] as? String),
              let ref = req["ref"] as? String, let el = snap.refs[ref] else {
            fail("BAD_REF", "unknown element ref"); return
        }
        var out: [String: Any] = ["ok": true, "ref": ref]
        if let t = axAttr(el, kAXSelectedTextAttribute) as? String { out["selectedText"] = t }
        var range = CFRange()
        if let raw = axAttr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID(),
           AXValueGetValue(raw as! AXValue, .cfRange, &range) {
            out["range"] = [range.location, range.length]
        }
        emit(out)

    case "scroll":
        guard trusted else { fail("AX_PERMISSION_DENIED", "Accessibility permission not granted"); return }
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        let dy = (req["dy"] as? NSNumber)?.int32Value ?? 0
        let dx = (req["dx"] as? NSNumber)?.int32Value ?? 0
        guard dy != 0 || dx != 0 else { fail("BAD_DELTA", "dy or dx required (positive = down/right)"); return }
        var point = CGPoint(x: 0, y: 0)
        if let ref = req["ref"] as? String, let snap = snapshot(req["snapshot"] as? String), let el = snap.refs[ref],
           let p = axPoint(el, kAXPositionAttribute), let sz = axSize(el, kAXSizeAttribute) {
            point = CGPoint(x: p.x + sz.width / 2, y: p.y + sz.height / 2)
        } else if let x = (req["x"] as? NSNumber)?.doubleValue, let y = (req["y"] as? NSNumber)?.doubleValue {
            point = CGPoint(x: x, y: y)
        } else if let win = resolveWindow(pid: pid, windowId: windowId),
                  let p = axPoint(win, kAXPositionAttribute), let sz = axSize(win, kAXSizeAttribute) {
            point = CGPoint(x: p.x + sz.width / 2, y: p.y + sz.height / 2)
        } else {
            fail("NO_TARGET", "give ref, x/y, or pid with an accessible window"); return
        }
        guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
            fail("SCROLL_FAILED", "cannot create scroll event"); return
        }
        ev.location = point
        CGEventPostToPid(pid, ev)
        emit(["ok": true, "how": "post-to-pid", "dy": dy, "dx": dx, "at": [Int(point.x), Int(point.y)], "cursorMoved": false])

    case "shot":
        guard pid > 0 else { fail("BAD_PID", "pid required"); return }
        var wid = windowId
        if wid == nil {
            wid = cgWindows(pid: pid).first?.id
        }
        guard let wid, wid > 0 else { fail("NO_WINDOW", "no on-screen window for pid \(pid)"); return }
        let tmp = NSTemporaryDirectory() + "vmouse-\(UUID().uuidString).png"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", "\(wid)", tmp]
        // keep the helper's stdout clean: this is the JSON protocol channel
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit() } catch {
            fail("SHOT_FAILED", "cannot run screencapture: \(error)"); return
        }
        guard FileManager.default.fileExists(atPath: tmp) else {
            fail("SHOT_FAILED", "screencapture produced no file", "grant Screen Recording to DeepSeek Harness"); return
        }
        let maxSide = (req["maxSide"] as? NSNumber)?.intValue ?? 1280
        let sips = Process()
        sips.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
        sips.arguments = ["-Z", "\(maxSide)", tmp]
        sips.standardOutput = FileHandle.nullDevice
        sips.standardError = FileHandle.nullDevice
        try? sips.run(); sips.waitUntilExit()
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: tmp)) else {
            fail("SHOT_FAILED", "cannot read capture"); return
        }
        try? FileManager.default.removeItem(atPath: tmp)
        emit(["ok": true, "windowId": wid, "bytes": data.count,
              "png": data.base64EncodedString(),
              "cursorMoved": false])

    default:
        fail("BAD_CMD", "unknown cmd '\(cmd)'")
    }
}

// MARK: - main loop

if args.count > 1, args[1] == "--selftest" {
    emit(["ok": true, "selftest": true, "axTrusted": AXIsProcessTrusted(),
          "cursor": "\(NSEvent.mouseLocation)", "pid": getpid()])
    exit(0)
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("BAD_JSON", "request must be a JSON object on one line")
        continue
    }
    handle(obj)
}
