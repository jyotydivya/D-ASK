import sys
import json
import pyautogui

def handle_command(command, args):
    try:
        if command == "mouse_move":
            x, y = args.get("x"), args.get("y")
            pyautogui.moveTo(x, y, duration=0.2)
            return {"success": True, "message": f"Moved mouse to ({x}, {y})"}
            
        elif command == "mouse_click":
            button = args.get("button", "left")
            clicks = args.get("clicks", 1)
            pyautogui.click(button=button, clicks=clicks)
            return {"success": True, "message": f"Clicked {button} {clicks} times"}
            
        elif command == "mouse_scroll":
            amount = args.get("amount", -10)
            pyautogui.scroll(amount)
            return {"success": True, "message": f"Scrolled {amount}"}
            
        elif command == "type_text":
            text = args.get("text", "")
            pyautogui.write(text, interval=0.05)
            return {"success": True, "message": f"Typed text"}
            
        elif command == "press_key":
            key = args.get("key", "")
            pyautogui.press(key)
            return {"success": True, "message": f"Pressed {key}"}
            
        elif command == "hotkey":
            keys = args.get("keys", [])
            pyautogui.hotkey(*keys)
            return {"success": True, "message": f"Pressed hotkey {keys}"}
            
        elif command == "position":
            x, y = pyautogui.position()
            return {"success": True, "position": {"x": x, "y": y}}
            
        elif command == "size":
            w, h = pyautogui.size()
            return {"success": True, "size": {"width": w, "height": h}}
            
        elif command == "take_screenshot":
            import base64
            import io
            
            # Method 1: mss (fastest)
            try:
                import mss
                with mss.mss() as sct:
                    monitor = sct.monitors[1]
                    sct_img = sct.grab(monitor)
                    from PIL import Image
                    img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
                    buffered = io.BytesIO()
                    img.save(buffered, format="JPEG", quality=80)
                    img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
                    return {"success": True, "image": img_str}
            except Exception as e1:
                # Method 2: PIL ImageGrab
                try:
                    from PIL import ImageGrab
                    img = ImageGrab.grab()
                    buffered = io.BytesIO()
                    img.save(buffered, format="JPEG", quality=80)
                    img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
                    return {"success": True, "image": img_str}
                except Exception as e2:
                    # Method 3: PowerShell GDI
                    try:
                        import subprocess
                        ps_script = (
                            "[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; "
                            "[Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; "
                            "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
                            "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; "
                            "$g = [System.Drawing.Graphics]::FromImage($bmp); "
                            "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); "
                            "$ms = New-Object System.IO.MemoryStream; "
                            "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); "
                            "[Convert]::ToBase64String($ms.ToArray())"
                        )
                        proc = subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], capture_output=True, text=True)
                        b64 = proc.stdout.strip().replace("\r", "").replace("\n", "")
                        if b64 and len(b64) > 100:
                            return {"success": True, "image": b64}
                        raise RuntimeError(proc.stderr or "Empty base64 output")
                    except Exception as e3:
                        return {"success": False, "error": f"Screen grab failed (mss: {e1}, PIL: {e2}, PS: {e3})"}
            
        else:
            return {"success": False, "error": f"Unknown command: {command}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    # Suppress fail-safe if in corners just in case, or leave it.
    pyautogui.FAILSAFE = False
    
    try:
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "Missing command and arguments"}))
            sys.exit(1)
            
        command = sys.argv[1]
        args = json.loads(sys.argv[2])
        
        result = handle_command(command, args)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
