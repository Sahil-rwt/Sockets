"use strict";

// ---------- Settings (must match server.py) ----------
const SERVER_URL = "ws://" + (location.host || "localhost:8765");
const MAX_FILE_SIZE = 5 * 1024 * 1024;   // 5 MB
const CHUNK_SIZE = 96 * 1024;            // raw bytes per chunk (multiple of 3 -> clean Base64)
const USERNAME_PATTERN = /^[A-Za-z0-9_ -]{1,20}$/;

// ---------- State ----------
let socket = null;
let myUsername = "";
let joined = false;
let sendingFile = false;
const incomingFiles = {};   // transfer_id -> { name, size, mime, chunks, received, body }

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const loginScreen = $("login-screen");
const chatScreen = $("chat-screen");
const loginForm = $("login-form");
const usernameInput = $("username-input");
const joinButton = $("join-button");
const loginError = $("login-error");
const usersList = $("users-list");
const userCount = $("user-count");
const statusDot = $("status-dot");
const statusText = $("status-text");
const reconnectButton = $("reconnect-button");
const messagesBox = $("messages");
const transferStatus = $("transfer-status");
const messageForm = $("message-form");
const messageInput = $("message-input");
const sendButton = $("send-button");
const attachButton = $("attach-button");
const fileInput = $("file-input");

// ---------- Small helpers ----------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function scrollToBottom() {
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ---------- Drawing messages (textContent only, so no HTML injection) ----------
function createMessage(className, senderText, timeIso) {
  const box = document.createElement("div");
  box.className = "message " + className;
  const header = document.createElement("div");
  header.className = "message-header";
  const sender = document.createElement("span");
  sender.textContent = senderText;
  const time = document.createElement("span");
  time.textContent = formatTime(timeIso);
  header.append(sender, time);
  const body = document.createElement("div");
  body.className = "message-body";
  box.append(header, body);
  messagesBox.appendChild(box);
  scrollToBottom();
  return body;
}

function addChatMessage(username, text, timeIso) {
  const own = username === myUsername;
  createMessage(own ? "own" : "other", own ? "You" : username, timeIso).textContent = text;
}

function addSystemMessage(text, isError, timeIso) {
  const box = document.createElement("div");
  box.className = "message system" + (isError ? " error" : "");
  box.textContent = formatTime(timeIso) + " - " + text;
  messagesBox.appendChild(box);
  scrollToBottom();
}

function renderUsers(users) {
  usersList.textContent = "";
  for (const name of users) {
    const item = document.createElement("li");
    item.textContent = name === myUsername ? name + " (you)" : name;
    usersList.appendChild(item);
  }
  userCount.textContent = users.length;
}

function setStatus(connected, label) {
  statusDot.className = "dot " + (connected ? "online" : "offline");
  statusText.textContent = label || (connected ? "Connected" : "Disconnected");
  messageInput.disabled = !connected;
  sendButton.disabled = !connected;
  attachButton.disabled = !connected || sendingFile;
  reconnectButton.hidden = connected || chatScreen.hidden || label === "Connecting...";
}

function showTransfer(text) {
  transferStatus.textContent = text;
}

// ---------- Connection ----------
function connect(username) {
  myUsername = username;
  joined = false;
  const thisSocket = new WebSocket(SERVER_URL);   // opens the WebSocket connection
  socket = thisSocket;
  thisSocket.onopen = () => thisSocket.send(JSON.stringify({ type: "join", username }));
  thisSocket.onmessage = (event) => handleServerMessage(event.data);
  thisSocket.onclose = () => handleClose(thisSocket);
  thisSocket.onerror = () => {};                   // onclose always follows an error
}

function handleClose(closedSocket) {
  if (closedSocket !== socket) return;            // an old socket we already replaced
  socket = null;
  const wasJoined = joined;
  joined = false;
  sendingFile = false;
  showTransfer("");
  abortAllIncoming("Connection lost.");
  setStatus(false);
  if (chatScreen.hidden) {
    loginError.textContent = "Could not connect to the server. Is server.py running?";
    joinButton.disabled = false;
  } else {
    addSystemMessage(wasJoined ? "Disconnected from the server." : "Could not reconnect to the server.", true);
    renderUsers([]);
  }
}

function handleJoinRejected(message) {
  // Server refused the username: close this socket quietly and let the user try again.
  const oldSocket = socket;
  socket = null;
  if (oldSocket) oldSocket.close();
  setStatus(false);
  if (chatScreen.hidden) {
    loginError.textContent = message;
    joinButton.disabled = false;
  } else {
    addSystemMessage(message, true);
  }
}

// ---------- Messages from the server ----------
function handleServerMessage(rawText) {
  let message;
  try {
    message = JSON.parse(rawText);
  } catch (error) {
    return;   // ignore anything that is not valid JSON
  }

  switch (message.type) {
    case "join_ok":
      joined = true;
      loginScreen.hidden = true;
      chatScreen.hidden = false;
      setStatus(true);
      messageInput.focus();
      break;
    case "error":
      if (!joined) {
        handleJoinRejected(message.message);
      } else {
        addSystemMessage(message.message, true);
        if (message.file_id && sendingFile) finishSending();   // server cancelled our upload
      }
      break;
    case "chat":
      addChatMessage(message.username, message.text, message.time);
      break;
    case "system":
      addSystemMessage(message.text, false, message.time);
      break;
    case "users":
      renderUsers(message.users);
      break;
    case "file_start":
      startIncomingFile(message);
      break;
    case "file_chunk":
      receiveFileChunk(message);
      break;
    case "file_end":
      finishIncomingFile(message);
      break;
    case "file_abort":
      abortIncomingFile(message.transfer_id, message.reason);
      break;
    case "file_ack":
      finishSending();
      addSystemMessage('You sent "' + message.name + '" (' + formatSize(message.size) + ")", false);
      break;
  }
}

// ---------- Receiving files ----------
function startIncomingFile(message) {
  const body = createMessage("other", message.sender, message.time);
  body.textContent = "Receiving " + message.name + " (" + formatSize(message.size) + ")... 0%";
  incomingFiles[message.transfer_id] = {
    name: message.name, size: message.size, mime: message.mime,
    chunks: [], received: 0, body: body,
  };
}

function receiveFileChunk(message) {
  const info = incomingFiles[message.transfer_id];
  if (!info) return;
  try {
    const bytes = base64ToBytes(message.data);
    info.chunks.push(bytes);
    info.received += bytes.length;
    const percent = Math.floor((info.received / info.size) * 100);
    info.body.textContent = "Receiving " + info.name + " (" + formatSize(info.size) + ")... " + percent + "%";
  } catch (error) {
    abortIncomingFile(message.transfer_id, "Received corrupted file data.");
  }
}

function finishIncomingFile(message) {
  const info = incomingFiles[message.transfer_id];
  if (!info) return;
  delete incomingFiles[message.transfer_id];
  if (info.received !== info.size) {
    info.body.textContent = "File " + info.name + " is incomplete and was discarded.";
    return;
  }
  // Only now (all bytes present) do we create the download link.
  const blob = new Blob(info.chunks, { type: info.mime || "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = info.name;
  link.textContent = "Download " + info.name + " (" + formatSize(info.size) + ")";
  info.body.textContent = "";
  info.body.appendChild(link);
}

function abortIncomingFile(transferId, reason) {
  const info = incomingFiles[transferId];
  if (!info) return;
  delete incomingFiles[transferId];
  info.body.textContent = "Transfer of " + info.name + " failed: " + (reason || "unknown error");
}

function abortAllIncoming(reason) {
  for (const transferId of Object.keys(incomingFiles)) abortIncomingFile(transferId, reason);
}

// ---------- Sending files ----------
function finishSending() {
  sendingFile = false;
  showTransfer("");
  attachButton.disabled = !(socket && socket.readyState === WebSocket.OPEN);
}

async function sendFile(file) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addSystemMessage("Not connected to the server.", true);
    return;
  }
  if (file.size === 0) {
    addSystemMessage("Cannot send an empty file.", true);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    addSystemMessage("File is too large (max " + formatSize(MAX_FILE_SIZE) + ").", true);
    return;
  }

  sendingFile = true;
  attachButton.disabled = true;
  const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    socket.send(JSON.stringify({
      type: "file_start", file_id: fileId, name: file.name,
      size: bytes.length, mime: file.type || "application/octet-stream",
    }));

    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      if (!sendingFile || !socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("transfer cancelled");
      }
      while (socket.bufferedAmount > 1024 * 1024) await sleep(20);   // don't flood the connection
      const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
      socket.send(JSON.stringify({
        type: "file_chunk", file_id: fileId, index: index++, data: bytesToBase64(chunk),
      }));
      const percent = Math.floor((Math.min(offset + CHUNK_SIZE, bytes.length) / bytes.length) * 100);
      showTransfer("Sending " + file.name + ": " + percent + "%");
      await sleep(0);   // let the browser redraw so the page never freezes
    }
    socket.send(JSON.stringify({ type: "file_end", file_id: fileId }));
    showTransfer("Waiting for the server to confirm " + file.name + "...");
  } catch (error) {
    if (sendingFile) {   // if it is already false, another handler reported the problem
      finishSending();
      addSystemMessage("File transfer failed: " + error.message, true);
    }
  }
}

// ---------- Events ----------
loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    loginError.textContent = "Username must be 1-20 letters, numbers, spaces, _ or -.";
    return;
  }
  loginError.textContent = "";
  joinButton.disabled = true;
  connect(username);
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;   // empty messages are never sent
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addSystemMessage("Not connected to the server.", true);
    return;
  }
  socket.send(JSON.stringify({ type: "chat", text: text }));
  messageInput.value = "";
  messageInput.focus();
});

attachButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";   // allows choosing the same file again later
  if (file) sendFile(file);
});

reconnectButton.addEventListener("click", () => {
  setStatus(false, "Connecting...");
  connect(myUsername);
});
