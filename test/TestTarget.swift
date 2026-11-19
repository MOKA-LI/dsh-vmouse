// Test target for dsh-vmouse: a tiny background Cocoa app with a button and an
// editable text field. Used to prove that AX element actions reach a NON-focused
// window without moving the hardware cursor or stealing frontmost focus.
import Cocoa

final class Target: NSObject {
    @objc func clicked(_ sender: Any) {
        let line = "clicked \(Date().timeIntervalSince1970)\n"
        if let fh = FileHandle(forWritingAtPath: "/tmp/vmouse-test-click.txt") {
            fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); fh.closeFile()
        } else {
            try? line.write(toFile: "/tmp/vmouse-test-click.txt", atomically: true, encoding: .utf8)
        }
    }
}

let handler = Target()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let win = NSWindow(contentRect: NSRect(x: 240, y: 140, width: 420, height: 240),
                   styleMask: [.titled, .closable], backing: .buffered, defer: false)
win.title = "VMouse Test Target"
win.isReleasedWhenClosed = false

let btn = NSButton(frame: NSRect(x: 40, y: 60, width: 140, height: 34))
btn.title = "ClickMe"
btn.bezelStyle = .rounded
btn.target = handler
btn.action = #selector(Target.clicked(_:))
win.contentView?.addSubview(btn)

let field = NSTextField(frame: NSRect(x: 40, y: 140, width: 320, height: 26))
field.stringValue = ""
field.placeholderString = "type here"
win.contentView?.addSubview(field)

let label = NSTextField(labelWithString: "vmouse test target")
label.frame = NSRect(x: 40, y: 190, width: 320, height: 20)
win.contentView?.addSubview(label)

win.orderFrontRegardless()  // visible without activating
app.run()
