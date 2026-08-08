(function () {
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const clientIdKey = "remoteChatClientId";
  const nameKey = "remoteChatName";

  const authPanel = document.getElementById("authPanel");
  const chatPanel = document.getElementById("chatPanel");
  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");
  const nameInput = document.getElementById("nameInput");
  const passwordInput = document.getElementById("passwordInput");
  const connectionStatus = document.getElementById("connectionStatus");
  const onlineCount = document.getElementById("onlineCount");
  const messagesEl = document.getElementById("messages");
  const messageForm = document.getElementById("messageForm");
  const messageInput = document.getElementById("messageInput");
  const fileInput = document.getElementById("fileInput");
  const filePreview = document.getElementById("filePreview");
  const fileName = document.getElementById("fileName");
  const fileMeta = document.getElementById("fileMeta");
  const removeFile = document.getElementById("removeFile");
  const emptyTemplate = document.getElementById("emptyTemplate");

  let author = "";
  let events = null;
  let hasMessages = false;
  const clientId = getClientId();

  nameInput.value = localStorage.getItem(nameKey) || "";

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    const password = passwordInput.value.trim();
    author = (nameInput.value || "访客").trim().slice(0, 24);

    try {
      const data = await postJson("/api/login", {
        password,
        name: author,
        clientId
      });

      localStorage.setItem(nameKey, author);
      authPanel.classList.add("hidden");
      chatPanel.classList.remove("hidden");
      renderMessages(data.messages || []);
      setOnline(data.online || 0);
      connectEvents();
      messageInput.focus();
    } catch (error) {
      loginError.textContent = error.message || "登录失败";
    }
  });

  messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const text = messageInput.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return;

    if (file && file.size > MAX_FILE_BYTES) {
      setStatus("文件不能超过 50 MB");
      return;
    }

    const submitButton = messageForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = "发送中";

    try {
      const media = file
        ? {
            name: file.name,
            dataUrl: await readFileAsDataUrl(file)
          }
        : null;

      await postJson("/api/messages", {
        text,
        media
      });

      messageInput.value = "";
      clearFile();
      autoresize();
      setStatus("已连接");
    } catch (error) {
      setStatus(error.message || "发送失败");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "发送";
      messageInput.focus();
    }
  });

  messageInput.addEventListener("input", autoresize);
  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) {
      clearFile();
      return;
    }

    fileName.textContent = file.name;
    fileMeta.textContent = `${file.type || "未知类型"} · ${formatBytes(file.size)}`;
    filePreview.classList.remove("hidden");
  });

  removeFile.addEventListener("click", clearFile);

  function getClientId() {
    const existing = localStorage.getItem(clientIdKey);
    if (existing) return existing;

    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    localStorage.setItem(clientIdKey, id);
    return id;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `请求失败：${response.status}`);
    }
    return data;
  }

  function connectEvents() {
    if (events) events.close();

    events = new EventSource("/api/events");
    events.addEventListener("open", () => setStatus("已连接"));
    events.addEventListener("init", (event) => {
      const data = JSON.parse(event.data);
      renderMessages(data.messages || []);
      setOnline(data.online || 0);
      setStatus("已连接");
    });
    events.addEventListener("message", (event) => {
      addMessage(JSON.parse(event.data));
    });
    events.addEventListener("presence", (event) => {
      const data = JSON.parse(event.data);
      setOnline(data.online || 0);
    });
    events.addEventListener("error", () => {
      setStatus("连接中断，正在重连");
    });
  }

  function setOnline(count) {
    onlineCount.textContent = `${count} 在线`;
  }

  function setStatus(text) {
    connectionStatus.textContent = text;
  }

  function renderMessages(items) {
    messagesEl.textContent = "";
    hasMessages = false;
    if (!items.length) {
      messagesEl.appendChild(emptyTemplate.content.cloneNode(true));
      return;
    }
    items.forEach(addMessage);
  }

  function addMessage(message) {
    if (!hasMessages) {
      messagesEl.textContent = "";
      hasMessages = true;
    }

    const mine = message.clientId === clientId;
    const wrapper = document.createElement("article");
    wrapper.className = `message ${mine ? "mine" : "theirs"}`;
    wrapper.dataset.id = message.id;

    const meta = document.createElement("div");
    meta.className = "meta";

    const authorEl = document.createElement("span");
    authorEl.textContent = mine ? "我" : message.author || "对方";

    const timeEl = document.createElement("time");
    timeEl.dateTime = message.time;
    timeEl.textContent = formatTime(message.time);

    meta.append(authorEl, timeEl);

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (message.text) {
      const text = document.createElement("p");
      text.textContent = message.text;
      bubble.appendChild(text);
    }

    if (message.media) {
      bubble.appendChild(renderMedia(message.media));
    }

    wrapper.append(meta, bubble);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMedia(media) {
    const box = document.createElement("div");
    box.className = "media";

    if (media.type && media.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = media.url;
      img.alt = media.name || "图片";
      img.loading = "lazy";
      box.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.src = media.url;
      video.controls = true;
      video.preload = "metadata";
      box.appendChild(video);
    }

    const caption = document.createElement("span");
    caption.className = "media-name";
    caption.textContent = media.name || "附件";
    box.appendChild(caption);
    return box;
  }

  function clearFile() {
    fileInput.value = "";
    filePreview.classList.add("hidden");
    fileName.textContent = "";
    fileMeta.textContent = "";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  function autoresize() {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 126)}px`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatTime(value) {
    const date = new Date(value);
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }
})();
