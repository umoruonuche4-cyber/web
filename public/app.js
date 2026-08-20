(function () {
  let maxFileBytes = 500 * 1024 * 1024;
  let directUpload = false;
  let cloudflareMode = false;

  const clientIdKey = "remoteChatClientId";
  const nameKey = "remoteChatName";
  const passwordKey = "remoteChatPassword";
  const REQUEST_TIMEOUT_MS = 20000;

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    });
  }

  const authPanel = document.getElementById("authPanel");
  const chatPanel = document.getElementById("chatPanel");
  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");
  const nameInput = document.getElementById("nameInput");
  const passwordInput = document.getElementById("passwordInput");
  const rememberPassword = document.getElementById("rememberPassword");
  const connectionStatus = document.getElementById("connectionStatus");
  const onlineCount = document.getElementById("onlineCount");

  const showChat = document.getElementById("showChat");
  const showDiary = document.getElementById("showDiary");
  const showSesame = document.getElementById("showSesame");
  const showGoals = document.getElementById("showGoals");
  const chatView = document.getElementById("chatView");
  const diaryView = document.getElementById("diaryView");
  const sesameView = document.getElementById("sesameView");
  const goalsView = document.getElementById("goalsView");

  const messagesEl = document.getElementById("messages");
  const messageForm = document.getElementById("messageForm");
  const messageInput = document.getElementById("messageInput");
  const fileInput = document.getElementById("fileInput");
  const filePreview = document.getElementById("filePreview");
  const fileName = document.getElementById("fileName");
  const fileMeta = document.getElementById("fileMeta");
  const removeFile = document.getElementById("removeFile");
  const emptyTemplate = document.getElementById("emptyTemplate");

  const diaryForm = document.getElementById("diaryForm");
  const diaryTitle = document.getElementById("diaryTitle");
  const diaryText = document.getElementById("diaryText");
  const diaryFileInput = document.getElementById("diaryFileInput");
  const diaryPreview = document.getElementById("diaryPreview");
  const diaryStatus = document.getElementById("diaryStatus");
  const diaryList = document.getElementById("diaryList");
  const emptyDiaryTemplate = document.getElementById("emptyDiaryTemplate");
  const cancelDiaryEdit = document.getElementById("cancelDiaryEdit");
  const saveDiaryButton = document.getElementById("saveDiaryButton");
  const sesameForm = document.getElementById("sesameForm");
  const sesameTitle = document.getElementById("sesameTitle");
  const sesameText = document.getElementById("sesameText");
  const sesameFileInput = document.getElementById("sesameFileInput");
  const sesamePreview = document.getElementById("sesamePreview");
  const sesameStatus = document.getElementById("sesameStatus");
  const sesameList = document.getElementById("sesameList");
  const emptySesameTemplate = document.getElementById("emptySesameTemplate");
  const cancelSesameEdit = document.getElementById("cancelSesameEdit");
  const saveSesameButton = document.getElementById("saveSesameButton");
  const goalForm = document.getElementById("goalForm");
  const goalTime = document.getElementById("goalTime");
  const goalText = document.getElementById("goalText");
  const saveGoalButton = document.getElementById("saveGoalButton");
  const goalStatus = document.getElementById("goalStatus");
  const goalList = document.getElementById("goalList");
  const emptyGoalsTemplate = document.getElementById("emptyGoalsTemplate");

  const startCall = document.getElementById("startCall");
  const incomingCall = document.getElementById("incomingCall");
  const incomingName = document.getElementById("incomingName");
  const acceptCall = document.getElementById("acceptCall");
  const declineCall = document.getElementById("declineCall");
  const callModal = document.getElementById("callModal");
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const callStatus = document.getElementById("callStatus");
  const toggleMic = document.getElementById("toggleMic");
  const toggleCamera = document.getElementById("toggleCamera");
  const hangupCall = document.getElementById("hangupCall");

  let author = "";
  let events = null;
  let hasMessages = false;
  let hasDiary = false;
  let diaryEntries = [];
  let hasSesame = false;
  let sesameEntries = [];
  let editingDiaryId = null;
  let editingDiaryMedia = [];
  let editingSesameId = null;
  let editingSesameMedia = [];
  let dailyGoals = [];
  let editingGoalId = null;
  let messageRefreshTimer = null;
  let messageRefreshInFlight = false;
  let lastMessageRefreshAt = 0;
  let pollingTimer = null;
  let callPollingTimer = null;
  let presenceTimer = null;
  let lastCallSignalTime = "";
  let pendingOffer = null;
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let queuedCandidates = [];
  let micEnabled = true;
  let cameraEnabled = true;

  const clientId = getClientId();
  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };

  nameInput.value = localStorage.getItem(nameKey) || "";
  passwordInput.value = localStorage.getItem(passwordKey) || "";
  rememberPassword.checked = localStorage.getItem(passwordKey) !== "";

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

      maxFileBytes = Number(data.maxUploadMb || 500) * 1024 * 1024;
      directUpload = Boolean(data.directUpload);
      cloudflareMode = Boolean(data.cloudflare);
      localStorage.setItem(nameKey, author);
      if (rememberPassword.checked) {
        localStorage.setItem(passwordKey, password);
      } else {
        localStorage.removeItem(passwordKey);
      }

      authPanel.classList.add("hidden");
      chatPanel.classList.remove("hidden");
      renderMessages(data.messages || []);
      if (data.messagesStale) scheduleMessageRefresh(800);
      setOnline(data.online || 0);
      if (cloudflareMode) {
        startPollingMode();
      } else {
        connectEvents();
      }
      scheduleMessageRefresh(1200);
      await loadDiary();
      await loadSesame();
      await loadGoals();
      messageInput.focus();
    } catch (error) {
      loginError.textContent = friendlyError(error, "登录失败");
    }
  });

  if (passwordInput.value) {
    window.setTimeout(() => {
      loginForm.requestSubmit();
    }, 120);
  }

  showChat.addEventListener("click", () => switchView("chat"));
  showDiary.addEventListener("click", () => switchView("diary"));
  showSesame.addEventListener("click", () => switchView("sesame"));
  showGoals.addEventListener("click", () => switchView("goals"));
  window.addEventListener("online", () => scheduleMessageRefresh(300));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !chatPanel.classList.contains("hidden")) {
      scheduleMessageRefresh(300);
      heartbeatPresence().catch(() => {});
    }
  });

  messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const text = messageInput.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return;

    if (file && file.size > maxFileBytes) {
      setStatus(`文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`);
      return;
    }

    const submitButton = messageForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = file ? "上传中" : "发送中";

    try {
      const media = file ? await prepareMedia(file, (percent) => setStatus(`上传中 ${percent}%：${file.name}`)) : null;
      await postJson("/api/messages", { text, media });

      messageInput.value = "";
      clearFile();
      autoresize(messageInput);
      setStatus("已连接");
    } catch (error) {
      setStatus(error.message || "发送失败");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "发送";
      messageInput.focus();
    }
  });

  diaryForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const title = diaryTitle.value.trim();
    const text = diaryText.value.trim();
    const files = Array.from(diaryFileInput.files || []).slice(0, 8);
    if (!title && !text && files.length === 0 && !editingDiaryMedia.length) return;

    const oversized = files.find((file) => file.size > maxFileBytes);
    if (oversized) {
      setDiaryStatus(`文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB：${oversized.name}`);
      return;
    }

    const submitButton = diaryForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = files.length ? "上传中" : "保存中";

    try {
      const media = [];
      for (let index = 0; index < files.length; index += 1) {
        setDiaryStatus(`正在上传 ${index + 1}/${files.length}：${files[index].name}`);
        media.push(await prepareMedia(files[index], (percent) => {
          setDiaryStatus(`正在上传 ${index + 1}/${files.length}：${percent}% ${files[index].name}`);
        }));
      }

      if (editingDiaryId) {
        await putJson(`/api/diary/${editingDiaryId}`, {
          title,
          text,
          existingMedia: editingDiaryMedia,
          media
        });
        setDiaryStatus("日记已更新");
        await loadDiary();
        cancelDiaryEditing();
      } else {
        await postJson("/api/diary", { title, text, media });
        diaryTitle.value = "";
        diaryText.value = "";
        clearDiaryFiles();
        setDiaryStatus("日记已保存");
      }
    } catch (error) {
      setDiaryStatus(error.message || "保存失败");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = editingDiaryId ? "更新日记" : "保存日记";
      diaryText.focus();
    }
  });

  async function handleSesameSubmit(event) {
    event.preventDefault();

    const title = sesameTitle.value.trim();
    const text = sesameText.value.trim();
    const files = Array.from(sesameFileInput.files || []).slice(0, 8);
    if (!title && !text && files.length === 0 && !editingSesameMedia.length) return;

    const oversized = files.find((file) => file.size > maxFileBytes);
    if (oversized) {
      setSesameStatus(`文件不能超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB：${oversized.name}`);
      return;
    }

    saveSesameButton.disabled = true;
    saveSesameButton.textContent = files.length ? "上传中" : "保存中";

    try {
      const media = [];
      for (let index = 0; index < files.length; index += 1) {
        setSesameStatus(`正在上传 ${index + 1}/${files.length}：${files[index].name}`);
        media.push(await prepareMedia(files[index], (percent) => {
          setSesameStatus(`正在上传 ${index + 1}/${files.length}：${percent}% ${files[index].name}`);
        }));
      }

      if (editingSesameId) {
        await putJson(`/api/sesame/${editingSesameId}`, {
          title,
          text,
          existingMedia: editingSesameMedia,
          media
        });
        setSesameStatus("芝麻已更新");
        await loadSesame();
        cancelSesameEditing();
      } else {
        await postJson("/api/sesame", { title, text, media });
        sesameTitle.value = "";
        sesameText.value = "";
        clearSesameFiles();
        setSesameStatus("芝麻已保存");
      }
    } catch (error) {
      setSesameStatus(error.message || "保存失败");
    } finally {
      saveSesameButton.disabled = false;
      saveSesameButton.textContent = editingSesameId ? "更新芝麻" : "保存芝麻";
      sesameText.focus();
    }
  }

  messageInput.addEventListener("input", () => autoresize(messageInput));
  diaryText.addEventListener("input", () => autoresize(diaryText));
  sesameText.addEventListener("input", () => autoresize(sesameText));
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

  diaryFileInput.addEventListener("change", renderDiaryPreview);
  sesameFileInput.addEventListener("change", renderSesamePreview);
  cancelDiaryEdit.addEventListener("click", cancelDiaryEditing);
  cancelSesameEdit.addEventListener("click", cancelSesameEditing);
  sesameForm.addEventListener("submit", handleSesameSubmit);
  goalForm.addEventListener("submit", handleGoalSubmit);
  removeFile.addEventListener("click", clearFile);
  startCall.addEventListener("click", startOutgoingCall);
  acceptCall.addEventListener("click", acceptIncomingCall);
  declineCall.addEventListener("click", declineIncomingCall);
  hangupCall.addEventListener("click", () => endCall(true));
  toggleMic.addEventListener("click", () => toggleTracks("audio"));
  toggleCamera.addEventListener("click", () => toggleTracks("video"));

  function getClientId() {
    const existing = localStorage.getItem(clientIdKey);
    if (existing) return existing;

    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    localStorage.setItem(clientIdKey, id);
    return id;
  }

  async function getJson(url) {
    const response = await fetchWithTimeout(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  async function postJson(url, payload) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  async function putJson(url, payload) {
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("服务正在唤醒，请稍后再试");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function friendlyError(error, fallback) {
    if (!navigator.onLine) return "网络已断开，请恢复网络后再试";
    return error.message || fallback;
  }

  async function prepareMedia(file, onProgress = null) {
    if (directUpload) {
      const signed = await postJson("/api/upload-url", {
        name: file.name,
        type: file.type,
        size: file.size
      });

      setStatus(`正在上传 ${file.name}`);
      await uploadToSignedUrl(signed.uploadUrl, file, onProgress);
      return signed.media;
    }

    return {
      name: file.name,
      dataUrl: await readFileAsDataUrl(file)
    };
  }

  async function uploadToSignedUrl(uploadUrl, file, onProgress = null) {
    if (typeof XMLHttpRequest === "undefined") {
      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file);
      const response = await fetch(uploadUrl, {
        method: "PUT",
        body: form
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(uploadErrorMessage(response.status, text));
      }
      return;
    }

    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", file);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(uploadErrorMessage(xhr.status, xhr.responseText || "")));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("上传失败，请检查网络后重试")));
      xhr.addEventListener("timeout", () => reject(new Error("上传超时，请换稳定网络后重试")));
      xhr.timeout = 0;
      xhr.send(form);
    });
  }

  function uploadErrorMessage(status, rawText) {
    const text = String(rawText || "");
    if (status === 413 || text.includes("EntityTooLarge") || text.includes("Payload too large")) {
      return "上传失败：视频超过 Supabase 当前允许的单文件大小。免费版通常最多 50MB；要传 1GB 以上，需要在 Supabase Storage Settings 调高 Global file size limit，并确保 bucket 的 file_size_limit 也足够大。";
    }

    if (status === 400 && text.includes("maximum allowed size")) {
      return "上传失败：Supabase 的 bucket 或全局文件大小限制太小，请重新运行 supabase-setup.sql，并检查 Storage Settings 的全局上传上限。";
    }

    return `上传失败：${status} ${text}`;
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
    events.addEventListener("diary", (event) => {
      addDiaryEntry(JSON.parse(event.data));
    });
    events.addEventListener("diary-update", () => {
      loadDiary();
    });
    events.addEventListener("sesame", (event) => {
      addSesameEntry(JSON.parse(event.data));
    });
    events.addEventListener("sesame-update", () => {
      loadSesame();
    });
    events.addEventListener("goals", (event) => {
      const data = JSON.parse(event.data);
      renderGoals(data.goals || []);
    });
    events.addEventListener("presence", (event) => {
      const data = JSON.parse(event.data);
      setOnline(data.online || 0);
    });
    events.addEventListener("call", (event) => {
      handleCallSignal(JSON.parse(event.data));
    });
    events.addEventListener("error", () => {
      setStatus("连接中断，正在重连");
    });
  }

  function startPollingMode() {
    setStatus("已连接");
    if (events) {
      events.close();
      events = null;
    }

    window.clearInterval(pollingTimer);
    window.clearInterval(callPollingTimer);
    window.clearInterval(presenceTimer);

    pollingTimer = window.setInterval(() => {
      refreshMessages().catch(() => {});
      loadDiary().catch(() => {});
      loadSesame().catch(() => {});
      loadGoals().catch(() => {});
    }, 3500);

    callPollingTimer = window.setInterval(() => {
      pollCallSignals().catch(() => {});
    }, 1500);

    heartbeatPresence().catch(() => {});
    presenceTimer = window.setInterval(() => {
      heartbeatPresence().catch(() => {});
    }, 12000);
  }

  async function heartbeatPresence() {
    if (chatPanel.classList.contains("hidden") || document.hidden) return;
    const data = await postJson("/api/presence", {});
    setOnline(data.online || 0);
  }

  async function pollCallSignals() {
    if (!cloudflareMode || chatPanel.classList.contains("hidden")) return;
    const query = lastCallSignalTime ? `?after=${encodeURIComponent(lastCallSignalTime)}` : "";
    const data = await getJson(`/api/call-signals${query}`);
    const signals = Array.isArray(data.signals) ? data.signals : [];
    signals.forEach((signal) => {
      lastCallSignalTime = signal.time || lastCallSignalTime;
      handleCallSignal(signal);
    });
  }

  function switchView(view) {
    const diaryActive = view === "diary";
    const sesameActive = view === "sesame";
    const goalsActive = view === "goals";
    showDiary.classList.toggle("active", diaryActive);
    showSesame.classList.toggle("active", sesameActive);
    showGoals.classList.toggle("active", goalsActive);
    showChat.classList.toggle("active", !diaryActive && !sesameActive && !goalsActive);
    diaryView.classList.toggle("hidden", !diaryActive);
    sesameView.classList.toggle("hidden", !sesameActive);
    goalsView.classList.toggle("hidden", !goalsActive);
    chatView.classList.toggle("hidden", diaryActive || sesameActive || goalsActive);
    if (diaryActive) diaryText.focus();
    if (sesameActive) sesameText.focus();
    if (goalsActive) goalText.focus();
  }

  function setOnline(count) {
    onlineCount.textContent = `${count} 在线`;
  }

  function setStatus(text) {
    connectionStatus.textContent = text;
  }

  function setDiaryStatus(text) {
    diaryStatus.textContent = text;
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
    if (message.id && messagesEl.querySelector(`[data-id="${message.id}"]`)) return;

    if (!hasMessages) {
      messagesEl.textContent = "";
      hasMessages = true;
    }

    ensureMessageDateSeparator(message.time);

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

  function ensureMessageDateSeparator(value) {
    const key = messageDateKey(value);
    if (!key || messagesEl.querySelector(`[data-date="${key}"]`)) return;

    const separator = document.createElement("div");
    separator.className = "date-separator";
    separator.dataset.date = key;
    separator.textContent = formatDateLabel(value);
    messagesEl.appendChild(separator);
  }

  function scheduleMessageRefresh(delay = 1000) {
    window.clearTimeout(messageRefreshTimer);
    messageRefreshTimer = window.setTimeout(() => {
      refreshMessages().catch(() => {});
    }, delay);
  }

  async function refreshMessages() {
    if (messageRefreshInFlight || chatPanel.classList.contains("hidden")) return;
    if (Date.now() - lastMessageRefreshAt < 1200) return;

    messageRefreshInFlight = true;
    lastMessageRefreshAt = Date.now();

    try {
      const data = await getJson(`/api/messages?t=${Date.now()}`);
      renderMessages(data.messages || []);
      if (Number.isFinite(Number(data.online))) setOnline(Number(data.online));
      if (data.stale) scheduleMessageRefresh(2500);
    } catch (error) {
      setStatus(error.message || "History loading failed, retrying...");
      scheduleMessageRefresh(3000);
    } finally {
      messageRefreshInFlight = false;
    }
  }

  async function loadDiary() {
    try {
      const data = await getJson("/api/diary");
      renderDiaryEntries(data.entries || []);
    } catch (error) {
      setDiaryStatus(error.message || "日记加载失败");
    }
  }

  async function loadSesame() {
    try {
      const data = await getJson("/api/sesame");
      renderSesameEntries(data.entries || []);
    } catch (error) {
      setSesameStatus(error.message || "芝麻加载失败");
    }
  }

  async function loadGoals() {
    try {
      const data = await getJson("/api/goals");
      renderGoals(data.goals || []);
    } catch (error) {
      setGoalStatus(error.message || "目标加载失败");
    }
  }

  async function handleGoalSubmit(event) {
    event.preventDefault();
    const text = goalText.value.trim();
    if (!text) return;

    if (editingGoalId) {
      const goal = dailyGoals.find((item) => item.id === editingGoalId);
      if (goal) {
        goal.text = text;
        goal.time = goalTime.value;
      }
    } else {
      dailyGoals.push({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        text,
        time: goalTime.value,
        doneDates: []
      });
    }

    await saveGoals();
    resetGoalForm();
  }

  async function saveGoals() {
    saveGoalButton.disabled = true;
    try {
      const data = await putJson("/api/goals", { goals: dailyGoals });
      renderGoals(data.goals || []);
      setGoalStatus("目标已保存");
    } catch (error) {
      setGoalStatus(error.message || "目标保存失败");
    } finally {
      saveGoalButton.disabled = false;
    }
  }

  function renderGoals(goals) {
    dailyGoals = goals.slice().sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
    goalList.textContent = "";
    if (!dailyGoals.length) {
      goalList.appendChild(emptyGoalsTemplate.content.cloneNode(true));
      return;
    }

    const today = todayKey();
    dailyGoals.forEach((goal) => {
      const item = document.createElement("article");
      item.className = "goal-item";
      item.dataset.id = goal.id;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Array.isArray(goal.doneDates) && goal.doneDates.includes(today);
      checkbox.addEventListener("change", () => toggleGoalDone(goal.id, checkbox.checked));

      const content = document.createElement("div");
      content.className = "goal-content";

      const title = document.createElement("strong");
      title.textContent = goal.text;

      const time = document.createElement("span");
      time.textContent = goal.time ? `每天 ${goal.time}` : "每天重复";

      content.append(title, time);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "entry-action";
      editButton.textContent = "编辑";
      editButton.addEventListener("click", () => startGoalEditing(goal));

      item.append(checkbox, content, editButton);
      goalList.appendChild(item);
    });
  }

  async function toggleGoalDone(id, done) {
    try {
      const data = await postJson(`/api/goals/${id}/done`, {
        date: todayKey(),
        done
      });
      const index = dailyGoals.findIndex((goal) => goal.id === id);
      if (index !== -1) dailyGoals[index] = data.goal;
      renderGoals(dailyGoals);
    } catch (error) {
      setGoalStatus(error.message || "完成状态保存失败");
      await loadGoals();
    }
  }

  function startGoalEditing(goal) {
    editingGoalId = goal.id;
    goalTime.value = goal.time || "";
    goalText.value = goal.text || "";
    saveGoalButton.textContent = "更新";
    goalText.focus();
  }

  function resetGoalForm() {
    editingGoalId = null;
    goalTime.value = "";
    goalText.value = "";
    saveGoalButton.textContent = "添加";
  }

  function setGoalStatus(text) {
    goalStatus.textContent = text;
  }

  function renderDiaryEntries(entries) {
    diaryEntries = entries.slice();
    diaryList.textContent = "";
    hasDiary = false;
    if (!diaryEntries.length) {
      diaryList.appendChild(emptyDiaryTemplate.content.cloneNode(true));
      return;
    }
    diaryEntries.forEach(addDiaryEntry);
  }

  function addDiaryEntry(entry) {
    if (!hasDiary) {
      diaryList.textContent = "";
      hasDiary = true;
    }

    if (diaryList.querySelector(`[data-id="${entry.id}"]`)) return;

    const article = document.createElement("article");
    article.className = "diary-entry";
    article.dataset.id = entry.id;

    const header = document.createElement("div");
    header.className = "diary-entry-header";

    const title = document.createElement("h2");
    title.textContent = entry.title || "没有标题的日记";

    const meta = document.createElement("time");
    meta.dateTime = entry.time;
    meta.textContent = `${entry.author || "我"} · ${formatFullDateTime(entry.time)}`;

    const editButton = document.createElement("button");
    editButton.className = "entry-action";
    editButton.type = "button";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", () => startDiaryEditing(entry));

    const copyButton = document.createElement("button");
    copyButton.className = "entry-action secondary-action";
    copyButton.type = "button";
    copyButton.textContent = "转到芝麻";
    copyButton.addEventListener("click", () => copyDiaryToSesame(entry));

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.append(editButton, copyButton);

    header.append(title, meta, actions);
    article.appendChild(header);

    if (entry.text) {
      const text = document.createElement("p");
      text.className = "diary-entry-text";
      text.textContent = entry.text;
      article.appendChild(text);
    }

    const mediaItems = Array.isArray(entry.media) ? entry.media : [];
    if (mediaItems.length) {
      const grid = document.createElement("div");
      grid.className = "diary-media-grid";
      mediaItems.forEach((item) => grid.appendChild(renderMedia(item)));
      article.appendChild(grid);
    }

    diaryList.prepend(article);
  }

  function startDiaryEditing(entry) {
    editingDiaryId = entry.id;
    editingDiaryMedia = Array.isArray(entry.media) ? entry.media.slice() : [];
    diaryTitle.value = entry.title || "";
    diaryText.value = entry.text || "";
    clearDiaryFiles();
    cancelDiaryEdit.classList.remove("hidden");
    saveDiaryButton.textContent = "更新日记";
    setDiaryStatus(`正在编辑：${entry.title || "没有标题的日记"}`);
    diaryTitle.focus();
    diaryForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelDiaryEditing() {
    editingDiaryId = null;
    editingDiaryMedia = [];
    diaryTitle.value = "";
    diaryText.value = "";
    clearDiaryFiles();
    cancelDiaryEdit.classList.add("hidden");
    saveDiaryButton.textContent = "保存日记";
  }

  async function copyDiaryToSesame(entry) {
    try {
      setDiaryStatus("正在转到芝麻...");
      await postJson("/api/sesame", {
        title: entry.title || "来自日记",
        text: entry.text || "",
        media: Array.isArray(entry.media) ? entry.media : []
      });
      await loadSesame();
      setDiaryStatus("已转到芝麻");
    } catch (error) {
      setDiaryStatus(error.message || "转到芝麻失败");
    }
  }

  function renderSesameEntries(entries) {
    sesameEntries = entries.slice();
    sesameList.textContent = "";
    hasSesame = false;
    if (!sesameEntries.length) {
      sesameList.appendChild(emptySesameTemplate.content.cloneNode(true));
      return;
    }
    sesameEntries.forEach(addSesameEntry);
  }

  function addSesameEntry(entry) {
    if (!hasSesame) {
      sesameList.textContent = "";
      hasSesame = true;
    }

    if (sesameList.querySelector(`[data-id="${entry.id}"]`)) return;

    const article = document.createElement("article");
    article.className = "diary-entry";
    article.dataset.id = entry.id;

    const header = document.createElement("div");
    header.className = "diary-entry-header";

    const title = document.createElement("h2");
    title.textContent = entry.title || "没有标题的芝麻";

    const meta = document.createElement("time");
    meta.dateTime = entry.time;
    meta.textContent = `${entry.author || "我"} · ${formatFullDateTime(entry.time)}`;

    const editButton = document.createElement("button");
    editButton.className = "entry-action";
    editButton.type = "button";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", () => startSesameEditing(entry));

    header.append(title, meta, editButton);
    article.appendChild(header);

    if (entry.text) {
      const text = document.createElement("p");
      text.className = "diary-entry-text";
      text.textContent = entry.text;
      article.appendChild(text);
    }

    const mediaItems = Array.isArray(entry.media) ? entry.media : [];
    if (mediaItems.length) {
      const grid = document.createElement("div");
      grid.className = "diary-media-grid";
      mediaItems.forEach((item) => grid.appendChild(renderMedia(item)));
      article.appendChild(grid);
    }

    sesameList.prepend(article);
  }

  function startSesameEditing(entry) {
    editingSesameId = entry.id;
    editingSesameMedia = Array.isArray(entry.media) ? entry.media.slice() : [];
    sesameTitle.value = entry.title || "";
    sesameText.value = entry.text || "";
    clearSesameFiles();
    cancelSesameEdit.classList.remove("hidden");
    saveSesameButton.textContent = "更新芝麻";
    setSesameStatus(`正在编辑：${entry.title || "没有标题的芝麻"}`);
    sesameTitle.focus();
    sesameForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelSesameEditing() {
    editingSesameId = null;
    editingSesameMedia = [];
    sesameTitle.value = "";
    sesameText.value = "";
    clearSesameFiles();
    cancelSesameEdit.classList.add("hidden");
    saveSesameButton.textContent = "保存芝麻";
  }

  function renderDiaryPreview() {
    const files = Array.from(diaryFileInput.files || []);
    diaryPreview.textContent = "";
    if (!files.length) {
      diaryPreview.classList.add("hidden");
      return;
    }

    files.slice(0, 8).forEach((file) => {
      const item = document.createElement("div");
      item.className = "diary-preview-item";
      item.textContent = `${file.name} · ${formatBytes(file.size)}`;
      diaryPreview.appendChild(item);
    });

    if (files.length > 8) {
      const item = document.createElement("div");
      item.className = "diary-preview-item";
      item.textContent = "一次最多保存 8 个附件";
      diaryPreview.appendChild(item);
    }

    diaryPreview.classList.remove("hidden");
  }

  function renderSesamePreview() {
    const files = Array.from(sesameFileInput.files || []);
    sesamePreview.textContent = "";
    if (!files.length) {
      sesamePreview.classList.add("hidden");
      return;
    }

    files.slice(0, 8).forEach((file) => {
      const item = document.createElement("div");
      item.className = "diary-preview-item";
      item.textContent = `${file.name} · ${formatBytes(file.size)}`;
      sesamePreview.appendChild(item);
    });

    if (files.length > 8) {
      const item = document.createElement("div");
      item.className = "diary-preview-item";
      item.textContent = "一次最多保存 8 个附件";
      sesamePreview.appendChild(item);
    }

    sesamePreview.classList.remove("hidden");
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

  async function startOutgoingCall() {
    try {
      await openCall();
      const pc = await ensurePeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendCallSignal("call-offer", pc.localDescription);
      setCallStatus("正在呼叫对方");
    } catch (error) {
      setCallStatus(error.message || "无法发起视频通话");
      endCall(false);
    }
  }

  async function acceptIncomingCall() {
    if (!pendingOffer) return;

    try {
      incomingCall.classList.add("hidden");
      await openCall();
      const pc = await ensurePeerConnection();
      await pc.setRemoteDescription(pendingOffer.payload);
      pendingOffer = null;
      await flushQueuedCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendCallSignal("call-answer", pc.localDescription);
      setCallStatus("已接听，正在连接");
    } catch (error) {
      setCallStatus(error.message || "接听失败");
      endCall(true);
    }
  }

  async function declineIncomingCall() {
    incomingCall.classList.add("hidden");
    pendingOffer = null;
    await sendCallSignal("call-decline", null);
  }

  async function openCall() {
    callModal.classList.remove("hidden");
    await startLocalMedia();
    setCallStatus("正在准备视频通话");
  }

  async function startLocalMedia() {
    if (localStream) return;

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    });
    localVideo.srcObject = localStream;
  }

  async function ensurePeerConnection() {
    if (peerConnection) return peerConnection;

    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendCallSignal("call-ice", event.candidate).catch(() => {});
      }
    };
    peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
      setCallStatus("视频通话中");
    };
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "connected") setCallStatus("视频通话中");
      if (state === "failed" || state === "disconnected") setCallStatus("连接不稳定");
      if (state === "closed") setCallStatus("通话已结束");
    };

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    return peerConnection;
  }

  async function handleCallSignal(signal) {
    if (!signal || signal.senderId === clientId) return;

    if (signal.signalType === "call-offer") {
      pendingOffer = signal;
      incomingName.textContent = signal.senderName || "对方";
      incomingCall.classList.remove("hidden");
      return;
    }

    if (signal.signalType === "call-answer" && peerConnection) {
      await peerConnection.setRemoteDescription(signal.payload);
      await flushQueuedCandidates();
      setCallStatus("已接通");
      return;
    }

    if (signal.signalType === "call-ice") {
      if (!peerConnection || !peerConnection.remoteDescription) {
        queuedCandidates.push(signal.payload);
      } else {
        await peerConnection.addIceCandidate(signal.payload);
      }
      return;
    }

    if (signal.signalType === "call-hangup" || signal.signalType === "call-decline") {
      incomingCall.classList.add("hidden");
      pendingOffer = null;
      endCall(false);
    }
  }

  async function flushQueuedCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;

    for (const candidate of queuedCandidates) {
      await peerConnection.addIceCandidate(candidate);
    }
    queuedCandidates = [];
  }

  async function sendCallSignal(signalType, payload) {
    await postJson("/api/call-signal", {
      signalType,
      payload
    });
  }

  function toggleTracks(kind) {
    if (!localStream) return;
    const tracks = kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks();
    const enabled = kind === "audio" ? !micEnabled : !cameraEnabled;

    tracks.forEach((track) => {
      track.enabled = enabled;
    });

    if (kind === "audio") {
      micEnabled = enabled;
      toggleMic.textContent = enabled ? "麦克风" : "麦克风关";
    } else {
      cameraEnabled = enabled;
      toggleCamera.textContent = enabled ? "摄像头" : "摄像头关";
    }
  }

  function endCall(notify) {
    if (notify) {
      sendCallSignal("call-hangup", null).catch(() => {});
    }

    incomingCall.classList.add("hidden");
    pendingOffer = null;
    queuedCandidates = [];

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    remoteStream = null;
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    callModal.classList.add("hidden");
    micEnabled = true;
    cameraEnabled = true;
    toggleMic.textContent = "麦克风";
    toggleCamera.textContent = "摄像头";
  }

  function setCallStatus(text) {
    callStatus.textContent = text;
  }

  function clearFile() {
    fileInput.value = "";
    filePreview.classList.add("hidden");
    fileName.textContent = "";
    fileMeta.textContent = "";
  }

  function clearDiaryFiles() {
    diaryFileInput.value = "";
    diaryPreview.textContent = "";
    diaryPreview.classList.add("hidden");
  }

  function clearSesameFiles() {
    sesameFileInput.value = "";
    sesamePreview.textContent = "";
    sesamePreview.classList.add("hidden");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  function autoresize(input) {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
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

  function formatDateTime(value) {
    const date = new Date(value);
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatFullDateTime(value) {
    const date = new Date(value);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function messageDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDateLabel(value) {
    const key = messageDateKey(value);
    const today = todayKey();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = messageDateKey(yesterday.toISOString());
    if (key === today) return `今天 ${key}`;
    if (key === yesterdayKey) return `昨天 ${key}`;
    return key;
  }

  function todayKey() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
})();
