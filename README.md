# WAP Toolkit for VSCode

- Modern replacement for the Nokia Mobile Internet Toolkit (NMIT)
- Develop websites for retro mobile devices & embedded devices using WML and WMLScript

## Features

**Editing (WML 1.3 & WMLScript)**
- Syntax highlighting, syntax checking, and code completion
- Code formatting
- Snippets for common WML/WMLScript patterns

**Preview & debugging**
- Live preview in the browser or a side panel (WML, WMLScript → HTML, JavaScript on the fly)
- Run and debug WMLScript

**WAP Browser**
- Test external WAP sites
- View, Debug and Save WML/WMLScript of the currently loaded page
- Save WBMP images
- To launch click **🌐 WAP Browser** icon in the status bar
- Supports WSP and WAP-over-HTTP protocols

**WAP networking**
- Minimal WAP server for serving WML, WMLScript, and WBMP files over using below protocols:
  - WSP connectionless (`wap.wspPort`)
  - WSP connection-oriented (`wap.wspCoPort`)
  - WAP-over-HTTP (`wap.httpPort`)
- Ports can be configured in settings.
- Click **Start WAP Server** in the status bar to launch the server.

**Compile & disassemble**
- Compile WML to WBXML and WMLScript to bytecode
- Disassemble WMLScript bytecode and WBXML/WMLC files
- View WBXML (`.wmlc`/`.wbxml`) files as WML

**Images**
- Preview WBMP images
- Convert BMP, PNG, JPEG, and Nokia OTB images to WBMP

---

## Examples

- [Nokia Mobile Internet Toolkit (NMIT) examples](https://github.com/jabezwinston/NMIT-examples)
- [WML/WMLScript examples](https://github.com/jabezwinston/WML-WMLScript-examples)

## Usage
See [Wiki](https://github.com/jabezwinston/vscode-wap-toolkit/wiki) for detailed usage.

---

## Background

[WAP (Wireless Application Protocol)](https://en.wikipedia.org/wiki/Wireless_Application_Protocol) was a standard for delivering internet content to mobile phones in the late 1990s and early 2000s, before modern smartphones. WML was WAP's markup language — a card/deck model designed for the constrained screens and bandwidth of early mobile devices.

WML and WMLScript are great for low-RAM embedded devices. This is an effort to revive the WAP/WML ecosystem for modern embedded devices.

---

## Specifications

- [WML 1.3 (WAP-191)](https://www.openmobilealliance.org/tech/affiliates/wap/wap-191-wml-20000219-a.pdf)
- [WBXML 1.3 (WAP-192)](https://www.openmobilealliance.org/tech/affiliates/wap/wap-192-wbxml-20010725-a.pdf)
- [WMLScript (WAP-193)](https://www.openmobilealliance.org/tech/affiliates/wap/wap-193-wmlscript-20001025-a.pdf)
- [WSP (WAP-230)](https://www.openmobilealliance.org/tech/affiliates/wap/wap-230-wsp-20010705-a.pdf)

---

## License

[Apache 2.0](LICENSE)
