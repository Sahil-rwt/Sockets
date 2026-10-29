"""Multiclient real-time chat server with file transfer (WebSockets + asyncio).

Run:  python server.py   then open  http://localhost:8765  in a browser.
The same port serves the web page (plain HTTP) and the chat (WebSocket).
"""
import asyncio
import base64
import binascii
import json
import re
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path

from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed

HOST = "localhost"
PORT = 8765
MAX_FILE_SIZE = 5 * 1024 * 1024        # 5 MB per file
MAX_MESSAGE_BYTES = 1024 * 1024        # largest single WebSocket message accepted
MAX_TEXT_LENGTH = 1000                 # longest chat message
USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_ -]{1,20}")

# Only these files are served over HTTP (so nobody can read other files).
STATIC_DIR = Path(__file__).parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/script.js": ("script.js", "text/javascript; charset=utf-8"),
}

clients = {}    # websocket connection -> username (the "online users" table)
transfers = {}  # websocket connection -> file transfer currently in progress


# ---------------------------------------------------------------- helpers
def now():
    return datetime.now(timezone.utc).isoformat()


def to_json(**fields):
    """Build one application-layer message (JSON text)."""
    return json.dumps(fields)


async def send_to(websocket, **fields):
    """Send to one client; ignore it if that client already disconnected."""
    try:
        await websocket.send(to_json(**fields))
    except ConnectionClosed:
        pass


def broadcast_all(**fields):
    """Send to every joined client. broadcast() skips closed connections."""
    broadcast(list(clients), to_json(**fields))


def broadcast_others(origin, **fields):
    """Send to every joined client except the one the message came from."""
    broadcast([ws for ws in clients if ws is not origin], to_json(**fields))


def broadcast_users():
    broadcast_all(type="users", users=sorted(clients.values(), key=str.lower))


# ------------------------------------------------------- message handlers
async def handle_join(websocket, message):
    if websocket in clients:
        return await send_to(websocket, type="error", message="You have already joined.")
    username = message.get("username")
    if not isinstance(username, str):
        return await send_to(websocket, type="error", message="Username is required.")
    username = username.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        return await send_to(websocket, type="error",
                             message="Username must be 1-20 letters, numbers, spaces, _ or -.")
    if username.lower() in (name.lower() for name in clients.values()):
        return await send_to(websocket, type="error", message="That username is already taken.")

    clients[websocket] = username   # no await between the check and this line, so no race
    print(f"[+] {username} joined ({len(clients)} online)")
    await send_to(websocket, type="join_ok", username=username)
    broadcast_all(type="system", text=f"{username} joined the chat", time=now())
    broadcast_users()


async def handle_chat(websocket, message):
    text = message.get("text")
    if not isinstance(text, str) or not text.strip():
        return await send_to(websocket, type="error", message="Cannot send an empty message.")
    text = text.strip()
    if len(text) > MAX_TEXT_LENGTH:
        return await send_to(websocket, type="error",
                             message=f"Message too long (max {MAX_TEXT_LENGTH} characters).")
    broadcast_all(type="chat", username=clients[websocket], text=text, time=now())


async def fail_transfer(websocket, file_id, reason):
    """Cancel the sender's transfer and tell everyone else to discard it."""
    transfer = transfers.pop(websocket, None)
    if transfer:
        broadcast_others(websocket, type="file_abort",
                         transfer_id=f"{clients[websocket]}:{transfer['file_id']}", reason=reason)
    await send_to(websocket, type="error", message=reason, file_id=file_id)


async def handle_file_start(websocket, message):
    file_id, name = message.get("file_id"), message.get("name")
    size, mime = message.get("size"), message.get("mime")
    if websocket in transfers:
        return await send_to(websocket, type="error", message="Another file transfer is in progress.")
    if not isinstance(file_id, str) or not 1 <= len(file_id) <= 40:
        return await send_to(websocket, type="error", message="Invalid file id.")
    if not isinstance(name, str):
        return await send_to(websocket, type="error", message="Invalid file name.", file_id=file_id)
    name = name.replace("\\", "/").split("/")[-1].strip()   # drop any folder path
    if not name or len(name) > 100:
        return await send_to(websocket, type="error", message="Invalid file name.", file_id=file_id)
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        return await send_to(websocket, type="error", message="Empty or invalid file size.", file_id=file_id)
    if size > MAX_FILE_SIZE:
        return await send_to(websocket, type="error",
                             message=f"File too large (max {MAX_FILE_SIZE // (1024 * 1024)} MB).",
                             file_id=file_id)
    if not isinstance(mime, str) or len(mime) > 100:
        mime = "application/octet-stream"

    transfers[websocket] = {"file_id": file_id, "name": name, "size": size,
                            "received": 0, "next_index": 0}
    broadcast_others(websocket, type="file_start", transfer_id=f"{clients[websocket]}:{file_id}",
                     sender=clients[websocket], name=name, size=size, mime=mime, time=now())


async def handle_file_chunk(websocket, message):
    transfer = transfers.get(websocket)
    file_id = message.get("file_id")
    if transfer is None or file_id != transfer["file_id"]:
        return await send_to(websocket, type="error", message="Unexpected file chunk.", file_id=file_id)
    data = message.get("data")
    if message.get("index") != transfer["next_index"] or not isinstance(data, str):
        return await fail_transfer(websocket, file_id, "File chunk out of order or invalid.")
    try:
        chunk = base64.b64decode(data, validate=True)   # Base64 text -> raw bytes
    except (binascii.Error, ValueError):
        return await fail_transfer(websocket, file_id, "File chunk is not valid Base64.")
    transfer["received"] += len(chunk)
    if transfer["received"] > transfer["size"]:
        return await fail_transfer(websocket, file_id, "Received more data than the declared file size.")
    transfer["next_index"] += 1
    # Relay the chunk to the other clients. Nothing is saved on the server.
    broadcast_others(websocket, type="file_chunk", transfer_id=f"{clients[websocket]}:{file_id}",
                     index=message["index"], data=data)


async def handle_file_end(websocket, message):
    transfer = transfers.get(websocket)
    file_id = message.get("file_id")
    if transfer is None or file_id != transfer["file_id"]:
        return await send_to(websocket, type="error", message="Unexpected end of file.", file_id=file_id)
    if transfer["received"] != transfer["size"]:
        return await fail_transfer(websocket, file_id, "File incomplete: size does not match.")
    del transfers[websocket]
    broadcast_others(websocket, type="file_end", transfer_id=f"{clients[websocket]}:{file_id}")
    await send_to(websocket, type="file_ack", file_id=file_id,
                  name=transfer["name"], size=transfer["size"])


HANDLERS = {
    "join": handle_join,
    "chat": handle_chat,
    "file_start": handle_file_start,
    "file_chunk": handle_file_chunk,
    "file_end": handle_file_end,
}


async def handle_message(websocket, raw):
    """Parse one incoming WebSocket message and call the matching handler."""
    if isinstance(raw, bytes):
        return await send_to(websocket, type="error", message="Binary messages are not supported.")
    try:
        message = json.loads(raw)
    except ValueError:
        return await send_to(websocket, type="error", message="Malformed JSON.")
    if not isinstance(message, dict):
        return await send_to(websocket, type="error", message="Message must be a JSON object.")
    handler_function = HANDLERS.get(message.get("type"))
    if handler_function is None:
        return await send_to(websocket, type="error", message="Unsupported message type.")
    if handler_function is not handle_join and websocket not in clients:
        return await send_to(websocket, type="error", message="Join the chat first.")
    await handler_function(websocket, message)


def remove_client(websocket):
    """Clean up after a disconnect (normal close, browser closed, or network error)."""
    transfer = transfers.pop(websocket, None)
    username = clients.pop(websocket, None)
    if username is None:
        return
    print(f"[-] {username} left ({len(clients)} online)")
    if transfer:
        broadcast_all(type="file_abort", transfer_id=f"{username}:{transfer['file_id']}",
                      reason=f"{username} disconnected during the file transfer.")
    broadcast_all(type="system", text=f"{username} left the chat", time=now())
    broadcast_users()


async def chat_handler(websocket):
    """Runs once per client connection, for as long as that client stays connected."""
    try:
        async for raw in websocket:     # waits for each incoming message (full duplex)
            await handle_message(websocket, raw)
    except ConnectionClosed:
        pass                            # client went away; nothing to do but clean up
    finally:
        remove_client(websocket)


# ------------------------------------------------------- HTTP (web page)
async def serve_static(connection, request):
    """Answer normal HTTP requests with the frontend; let WebSocket upgrades through."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None                     # None = continue with the WebSocket handshake
    entry = STATIC_FILES.get(request.path.split("?")[0])
    if entry is None:
        return connection.respond(HTTPStatus.NOT_FOUND, "404 Not found\n")
    filename, content_type = entry
    try:
        body = (STATIC_DIR / filename).read_text(encoding="utf-8")
    except OSError:
        return connection.respond(HTTPStatus.INTERNAL_SERVER_ERROR, "Could not read file\n")
    response = connection.respond(HTTPStatus.OK, body)
    del response.headers["Content-Type"]
    response.headers["Content-Type"] = content_type
    return response


async def main():
    async with serve(chat_handler, HOST, PORT, process_request=serve_static,
                     max_size=MAX_MESSAGE_BYTES) as server:
        print(f"Chat server running. Open http://{HOST}:{PORT} in your browser. Ctrl+C to stop.")
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
