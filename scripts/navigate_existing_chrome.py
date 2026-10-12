"""Navigate an already open Chrome window through its address bar."""

import ctypes
import sys
import time
from ctypes import wintypes


user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.SetProcessDPIAware()
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]


class KeyInput(ctypes.Structure):
    _fields_ = [
        ("vk", wintypes.WORD), ("scan", wintypes.WORD),
        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
        ("extra", ctypes.c_void_p),
    ]


class InputUnion(ctypes.Union):
    _fields_ = [("key", KeyInput), ("pad", ctypes.c_byte * 32)]


class Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("data", InputUnion)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT


def send(vk=0, scan=0, flags=0):
    event = Input(1, InputUnion(key=KeyInput(vk, scan, flags, 0, None)))
    if user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(Input)) != 1:
        raise OSError("Windows did not accept keyboard input")


def chord(key):
    send(0x11)
    send(key)
    send(key, flags=2)
    send(0x11, flags=2)


def text(value):
    for char in value:
        send(scan=ord(char), flags=4)
        send(scan=ord(char), flags=6)
        time.sleep(0.005)


def copied_url():
    chord(0x4C)
    chord(0x43)
    time.sleep(0.2)
    if not user32.OpenClipboard(None):
        raise OSError("Cannot read Chrome address bar")
    try:
        handle = user32.GetClipboardData(13)
        pointer = kernel32.GlobalLock(handle)
        try:
            value = ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()
        send(0x1B)
        send(0x1B, flags=2)
    return value


def main():
    handle = int(sys.argv[1])
    user32.ShowWindow(handle, 3)
    user32.SetForegroundWindow(handle)
    time.sleep(0.4)
    if user32.GetForegroundWindow() != handle:
        raise RuntimeError("Chrome window did not take focus")
    if len(sys.argv) > 2 and sys.argv[2] == "--form":
        user32.SetCursorPos(400, 390)
        user32.mouse_event(2, 0, 0, 0, 0)
        time.sleep(0.1)
        user32.mouse_event(4, 0, 0, 0, 0)
        chord(0x41)
        text(sys.argv[3])
        send(0x09)
        send(0x09, flags=2)
        text(sys.argv[4])
        send(0x09)
        send(0x09, flags=2)
        text(sys.argv[5])
        print("FORM_FILLED")
        return
    if len(sys.argv) > 2 and sys.argv[2] == "--clear-extra":
        user32.SetCursorPos(400, 475)
        user32.mouse_event(2, 0, 0, 0, 0)
        time.sleep(0.1)
        user32.mouse_event(4, 0, 0, 0, 0)
        for _ in range(2):
            send(0x09)
            send(0x09, flags=2)
            chord(0x41)
            send(0x08)
            send(0x08, flags=2)
        print("EXTRA_IDS_CLEARED")
        return
    if len(sys.argv) > 2 and sys.argv[2] == "--click":
        user32.SetCursorPos(int(sys.argv[3]), int(sys.argv[4]))
        user32.mouse_event(2, 0, 0, 0, 0)
        time.sleep(0.1)
        user32.mouse_event(4, 0, 0, 0, 0)
        time.sleep(7)
        print("CLICKED")
        return
    elif len(sys.argv) > 2 and sys.argv[2] == "--fill":
        user32.SetCursorPos(int(sys.argv[3]), int(sys.argv[4]))
        user32.mouse_event(2, 0, 0, 0, 0)
        user32.mouse_event(4, 0, 0, 0, 0)
        chord(0x41)
        text(sys.argv[5])
        time.sleep(0.5)
    elif len(sys.argv) > 2 and sys.argv[2] == "--clear":
        user32.SetCursorPos(int(sys.argv[3]), int(sys.argv[4]))
        user32.mouse_event(2, 0, 0, 0, 0)
        time.sleep(0.1)
        user32.mouse_event(4, 0, 0, 0, 0)
        chord(0x41)
        send(0x08)
        send(0x08, flags=2)
        print("CLEARED")
        return
    elif len(sys.argv) > 2 and sys.argv[2] == "--scroll":
        user32.SetCursorPos(1300, 700)
        user32.mouse_event(0x0800, 0, 0, int(sys.argv[3]), 0)
        time.sleep(0.5)
        print("SCROLLED")
        return
    elif len(sys.argv) > 2 and sys.argv[2] == "--new-tab":
        chord(0x54)
        time.sleep(0.5)
        text(sys.argv[3])
        time.sleep(0.2)
        send(0x0D)
        send(0x0D, flags=2)
        time.sleep(7)
    elif len(sys.argv) > 2:
        chord(0x4C)
        time.sleep(0.3)
        text(sys.argv[2])
        time.sleep(0.2)
        send(0x0D)
        send(0x0D, flags=2)
        time.sleep(7)
    title = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(handle, title, len(title))
    print("TITLE", title.value)
    print("URL", copied_url())


if __name__ == "__main__":
    main()
