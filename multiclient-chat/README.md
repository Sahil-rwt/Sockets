# Multiclient Real-Time Chat Application with File Transfer Using WebSockets

A small Computer Networks PBL project. A Python server (`websockets` + `asyncio`) lets many browser clients chat in real time and send files to each other. No database, no frameworks.

## How it works
- `server.py` listens on `localhost:8765`. The **same port** serves the web page (plain HTTP) and the chat (WebSocket upgrade), so no second web server is needed.
- Each browser opens one persistent WebSocket connection. Both sides can send at any time (full duplex).
- Every message is a JSON object with a `type` field (the application-layer protocol).
- Files are cut into 96 KB chunks, Base64-encoded, and sent as JSON. The server validates and relays chunks to the other clients without saving anything. Receivers rebuild the file and only show **Download** after the final chunk arrives and the size matches.

## Project structure
```
multiclient-chat/
├── server.py
├── requirements.txt
├── README.md
└── static/
    ├── index.html
    ├── style.css
    └── script.js
```

## Installation and running (Windows)
Requires Python 3.9+.
```bat
cd multiclient-chat
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python server.py
```
(PowerShell: if activation is blocked, run `Set-ExecutionPolicy -Scope Process RemoteSigned` first, or use Command Prompt.)

macOS/Linux: `python3 -m venv venv && source venv/bin/activate`, then the same `pip` and `python3 server.py`.

Stop the server with `Ctrl+C`.

## Testing with multiple clients
1. Start the server, then open `http://localhost:8765` in **two or three browser tabs** (or one normal and one private window).
2. Join each tab with a different username.

**Text messages / online users / join-leave**
- Type a message in tab 1: it must appear in all tabs at once.
- The Online list should show every name in every tab. Join a new tab: all tabs show "X joined the chat" and the list grows.
- Close a tab: the others show "X left the chat" and the name disappears from the list.
- Try a duplicate username (even different capitalization) in a new tab: it is rejected. Press Send with an empty box: nothing is sent.

**File transfer**
- In tab 1 click **Attach** and pick a small file (image, PDF, text). Tab 1 shows a progress line and "You sent ...". Other tabs show a message with a **Download** link when the transfer completes.
- Download it and compare with the original (right-click > Properties for size, or on Windows run `certutil -hashfile <file> SHA256` on both; the hashes must match).
- Pick a file larger than 5 MB: a clear error appears and nothing is sent.
- Stop the server with `Ctrl+C`: every tab shows "Disconnected" with a **Reconnect** button. Restart the server and click it.

## Troubleshooting
| Problem | Fix |
|---|---|
| `ModuleNotFoundError: websockets` | Activate the virtual environment, then `pip install -r requirements.txt`. |
| `address already in use` / port 8765 busy | Close the other server, or change `PORT` in `server.py` (the page picks up the port automatically when opened from the server). |
| "Could not connect to the server" on the login screen | `server.py` is not running. Start it and reload. |
| Page opens but chat will not connect | Open `http://localhost:8765`, not the HTML file directly from disk. |
| "Username already taken" | Another connected tab uses it; pick another name. |
| Browser shows a stale page | Hard refresh with `Ctrl+F5`. |
| `Set-ExecutionPolicy` / activation error in PowerShell | Use Command Prompt, or the command given above. |

## Message protocol (JSON over WebSocket)
| Direction | `type` | Fields |
|---|---|---|
| client -> server | `join` | `username` |
| client -> server | `chat` | `text` |
| client -> server | `file_start` / `file_chunk` / `file_end` | `file_id`, then `name,size,mime` / `index,data` (Base64) / nothing |
| server -> client | `join_ok` | `username` |
| server -> clients | `chat` | `username, text, time` |
| server -> clients | `system` | `text, time` (join/leave notices) |
| server -> clients | `users` | `users` (list) |
| server -> others | `file_start` / `file_chunk` / `file_end` / `file_abort` | `transfer_id` plus the fields above |
| server -> sender | `file_ack` | `file_id, name, size` |
| server -> client | `error` | `message`, optional `file_id` |

## Communication flow
1. Browser requests `http://localhost:8765` (HTTP) and receives the page.
2. `script.js` opens `ws://localhost:8765` (HTTP Upgrade handshake, then a persistent WebSocket).
3. Client sends `join`; server checks the name, replies `join_ok`, broadcasts a `system` message and the `users` list.
4. Client sends `chat`; server broadcasts it to everyone.
5. File: `file_start` -> many `file_chunk` -> `file_end`. Server checks name, size, chunk order, valid Base64 and that the total equals the declared size, relaying each chunk to the other clients. Sender gets `file_ack`; receivers get a Download link.
6. When a connection closes, `remove_client` deletes the user, cancels any unfinished transfer (`file_abort`), and broadcasts the leave notice and new list.

## Important functions
**server.py**
- `main()` starts the server; `serve_static()` answers HTTP requests and lets WebSocket upgrades through.
- `chat_handler()` runs once per connection and loops over incoming messages; `handle_message()` parses JSON and dispatches by `type`.
- `handle_join()` validates and registers usernames; `handle_chat()` validates and broadcasts text.
- `handle_file_start/chunk/end()` validate and relay a file transfer; `fail_transfer()` cancels a bad one.
- `broadcast_all()`, `broadcast_others()`, `send_to()` send messages safely (closed connections are skipped).
- `remove_client()` cleans up after a disconnect.

**script.js**
- `connect()` opens the WebSocket; `handleServerMessage()` reacts to each message type; `handleClose()` handles lost connections.
- `sendFile()` slices, encodes and sends a file with back-pressure; `startIncomingFile/receiveFileChunk/finishIncomingFile` rebuild a received file and create the download link.
- `renderUsers()`, `addChatMessage()`, `addSystemMessage()`, `setStatus()` update the page.

## Ten likely viva questions
1. **What is client-server architecture?** Clients request services from a central server; here browsers are clients and `server.py` coordinates and relays everything.
2. **What is a WebSocket?** A persistent two-way TCP-based connection created by upgrading an HTTP request, used for real-time communication.
3. **How is it different from HTTP?** HTTP is request-response and the client must ask each time; a WebSocket stays open and either side can send at any time.
4. **What does full duplex mean?** Both sides can send and receive simultaneously on the same connection.
5. **Which transport protocol is used?** TCP, which gives reliable, ordered delivery (important for file chunks).
6. **How does the WebSocket handshake work?** The client sends an HTTP GET with `Upgrade: websocket`; the server replies `101 Switching Protocols`, and the connection then carries WebSocket frames.
7. **What is the application-layer protocol here?** Our own JSON messages with a `type` field (join, chat, file_start, ...).
8. **How are files transferred?** Split into chunks, Base64-encoded in JSON, relayed by the server, and reassembled and size-checked by receivers.
9. **Why Base64?** JSON is text, and Base64 represents binary bytes safely as text (cost: about 33% larger).
10. **How does the server handle many clients at once?** `asyncio` runs one lightweight task per connection on a single thread; the `clients` dictionary tracks who is online and `broadcast` sends to all of them.

## Limits (by design)
Single room, no login, no history, no encryption (`ws://`, not `wss://`), 5 MB file limit, files are held only in browser memory.
