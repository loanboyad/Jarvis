/* J.A.R.V.I.S. — assistant vocal (Web Speech API + Claude via proxy) */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body,
    reactor: $("reactor"),
    status: $("status-text"),
    hint: $("hint"),
    transcript: $("transcript"),
    reply: $("reply"),
    errorBanner: $("error-banner"),
    errorText: $("error-text"),
    errorRetry: $("error-retry"),
    settings: $("settings"),
    settingsBtn: $("settings-btn"),
    voiceSelect: $("voice-select"),
    rate: $("rate"),
    rateOut: $("rate-out"),
    pitch: $("pitch"),
    pitchOut: $("pitch-out"),
    token: $("token"),
    testVoice: $("test-voice"),
    clearHistory: $("clear-history"),
  };

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const API_URL = "api/chat";
  const REQUEST_TIMEOUT_MS = 45000;
  const COMMAND_TIMEOUT_MS = 8000; // délai pour formuler la demande après « Jarvis »
  const FOLLOW_UP_TIMEOUT_MS = 7000; // écoute sans mot d'activation après une réponse
  const MAX_HISTORY = 30;

  // Tolère les transcriptions approximatives du mot d'activation.
  const WAKE_RE = /(?:^|[\s,.!?])(?:(?:h[eéè]y|hé|eh|ok|dis|salut)[\s,]+)?(jarvis|jarvi|jarvice|jarviss|jarvys|djarvis|charvis|jar vis|jarbis)(?=$|[\s,.!?'])/i;
  const CLEAR_RE = /\b(efface|oublie|réinitialise|nouvelle conversation)\b.*\b(conversation|tout|historique|mémoire)\b/i;

  const STATUS = {
    offline: ["Hors ligne", "Touchez le réacteur pour initialiser"],
    idle: ["En veille", "Dites « Jarvis » ou touchez le réacteur"],
    listening: ["À l'écoute", "Je vous écoute, Monsieur"],
    thinking: ["Analyse en cours", "Touchez pour annuler"],
    speaking: ["Réponse", "Touchez pour interrompre"],
    error: ["Anomalie", "Touchez le réacteur pour réessayer"],
  };

  // ---------------------------------------------------------------------------
  // Stockage (protégé : peut échouer en navigation privée)
  // ---------------------------------------------------------------------------
  const store = {
    get(area, key, fallback) {
      try {
        const raw = window[area].getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(area, key, value) {
      try {
        window[area].setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  const settings = Object.assign(
    { voiceURI: "", rate: 0.95, pitch: 0.8, token: "" },
    store.get("localStorage", "jarvis.settings", {})
  );
  // Historique conservé pendant la session (onglet / app ouverte).
  let history = store.get("sessionStorage", "jarvis.history", []);

  // ---------------------------------------------------------------------------
  // État & interface
  // ---------------------------------------------------------------------------
  let state = "offline";
  let initialized = false;

  function setState(next) {
    state = next;
    els.body.dataset.state = next;
    const [status, hint] = STATUS[next];
    els.status.textContent = status;
    els.hint.textContent = hint;
  }

  function showError(message, retry) {
    els.errorText.textContent = message;
    els.errorBanner.hidden = false;
    els.errorRetry.onclick = () => {
      hideError();
      (retry || boot)();
    };
  }

  function hideError() {
    els.errorBanner.hidden = true;
  }

  // Bobines du réacteur, générées autour du noyau.
  (function buildCoils() {
    const g = document.querySelector(".coils");
    const ns = "http://www.w3.org/2000/svg";
    for (let i = 0; i < 10; i++) {
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", "95");
      rect.setAttribute("y", "40");
      rect.setAttribute("width", "10");
      rect.setAttribute("height", "16");
      rect.setAttribute("rx", "2");
      rect.style.transform = `rotate(${i * 36}deg)`;
      rect.style.animationDelay = `${i * 0.1}s`;
      g.appendChild(rect);
    }
  })();

  // ---------------------------------------------------------------------------
  // Petits bips d'interface (Web Audio)
  // ---------------------------------------------------------------------------
  let audioCtx;
  function chime(freqs) {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    freqs.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t = t0 + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  }
  const chimeOn = () => chime([880, 1320]);
  const chimeOff = () => chime([990, 660]);

  // ---------------------------------------------------------------------------
  // Synthèse vocale
  // ---------------------------------------------------------------------------
  const synth = window.speechSynthesis;
  let voices = [];
  let speakToken = 0;
  let level = 0;
  let levelTarget = 0;

  function frenchVoices() {
    return synth ? synth.getVoices().filter((v) => /^fr(-|_|$)/i.test(v.lang)) : [];
  }

  // Préférence pour une voix masculine / grave si le système en propose.
  function pickVoice() {
    const saved = voices.find((v) => v.voiceURI === settings.voiceURI);
    if (saved) return saved;
    const score = (v) =>
      (/fr[-_]fr/i.test(v.lang) ? 4 : 0) +
      (/(male|homme|masculin|thomas|paul|henri|nicolas|daniel|mathieu|frd|frc)/i.test(v.name + v.voiceURI) ? 3 : 0) +
      (/(female|femme|amélie|amelie|audrey|marie|julie|virginie|vlf|frb)/i.test(v.name + v.voiceURI) ? -2 : 0) +
      (/google|natural|neural|online/i.test(v.name) ? 1 : 0) +
      (v.localService ? 1 : 0);
    return voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  function refreshVoices() {
    voices = frenchVoices();
    const current = pickVoice();
    els.voiceSelect.innerHTML = "";
    if (!voices.length) {
      els.voiceSelect.append(new Option("Voix française par défaut", ""));
      return;
    }
    for (const v of voices) {
      const opt = new Option(`${v.name} (${v.lang})`, v.voiceURI);
      opt.selected = current && v.voiceURI === current.voiceURI;
      els.voiceSelect.append(opt);
    }
  }

  if (synth) {
    refreshVoices();
    synth.addEventListener?.("voiceschanged", refreshVoices);
  }

  function cleanForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_#`>~|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Chrome coupe parfois les énoncés longs : on découpe par phrases.
  function chunkText(text) {
    const sentences = text.match(/[^.!?…;:]+[.!?…;:]*\s*/g) || [text];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > 180 && current) {
        chunks.push(current.trim());
        current = "";
      }
      current += s;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function speakChunk(text, voice, token) {
    return new Promise((resolve) => {
      if (token !== speakToken) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice?.lang || "fr-FR";
      if (voice) u.voice = voice;
      u.rate = settings.rate;
      u.pitch = settings.pitch;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      // Filet de sécurité : onend ne se déclenche pas toujours sur Android.
      const guard = setTimeout(finish, 4000 + text.length * 110);
      u.onend = finish;
      u.onerror = finish;
      u.onboundary = () => {
        level = 1;
      };
      synth.speak(u);
    });
  }

  async function speak(text) {
    if (!synth) return;
    const token = ++speakToken;
    synth.cancel();
    const voice = pickVoice();
    for (const chunk of chunkText(cleanForSpeech(text))) {
      if (token !== speakToken) return;
      await speakChunk(chunk, voice, token);
    }
  }

  function stopSpeaking() {
    speakToken++;
    synth?.cancel();
  }

  // Animation du noyau pendant la parole.
  let lastJitter = 0;
  (function animateLevel(now) {
    if (state === "speaking") {
      if (now - lastJitter > 110) {
        levelTarget = 0.25 + Math.random() * 0.55;
        lastJitter = now;
      }
    } else {
      levelTarget = state === "listening" ? 0.15 : 0;
    }
    level += (levelTarget - level) * 0.25;
    els.body.style.setProperty("--level", level.toFixed(3));
    requestAnimationFrame(animateLevel);
  })(0);

  // ---------------------------------------------------------------------------
  // Reconnaissance vocale
  // ---------------------------------------------------------------------------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognizing = false; // le moteur tourne
  let wantListening = false; // il doit tourner
  let mode = "wake"; // "wake" (attend « Jarvis ») | "command" (attend la demande)
  let modeTimer = null;
  let restartDelay = 250;
  let lastStart = 0;
  let pendingCommand = "";

  function createRecognition() {
    const rec = new Recognition();
    rec.lang = "fr-FR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    rec.onstart = () => {
      recognizing = true;
    };

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternatives = Array.from(result, (alt) => alt.transcript.trim());
        if (result.isFinal) onFinal(alternatives);
        else interim += alternatives[0] + " ";
      }
      interim = interim.trim();
      if (!interim) return;
      if (mode === "wake" && WAKE_RE.test(interim) && state === "idle") {
        // Retour visuel immédiat dès que « Jarvis » est entendu.
        setState("listening");
        chimeOn();
      }
      if (mode === "command" || state === "listening") {
        els.transcript.textContent = interim;
        armModeTimer(mode === "command" ? COMMAND_TIMEOUT_MS : FOLLOW_UP_TIMEOUT_MS);
      }
    };

    rec.onerror = (event) => {
      switch (event.error) {
        case "not-allowed":
        case "service-not-allowed":
          wantListening = false;
          setState("error");
          showError(
            "Accès au micro refusé. Autorisez le micro pour ce site (icône à gauche de l'adresse › Autorisations), puis réessayez."
          );
          break;
        case "audio-capture":
          wantListening = false;
          setState("error");
          showError("Aucun micro détecté ou micro utilisé par une autre application.");
          break;
        case "network":
          // La reconnaissance de Chrome passe par les serveurs de Google.
          restartDelay = Math.min(restartDelay * 2, 15000);
          showError("Reconnaissance vocale indisponible : pas de réseau. Nouvelle tentative automatique…", () =>
            startListening("wake")
          );
          break;
        case "language-not-supported":
          wantListening = false;
          setState("error");
          showError("Le français n'est pas disponible pour la reconnaissance vocale sur cet appareil.");
          break;
        default:
          // "no-speech", "aborted" : rien d'anormal, on relance.
          break;
      }
    };

    rec.onend = () => {
      recognizing = false;
      if (!wantListening) return;
      // Évite une boucle de redémarrages trop rapide.
      const elapsed = Date.now() - lastStart;
      const delay = elapsed < 1000 ? Math.max(restartDelay, 1000) : restartDelay;
      setTimeout(ensureRunning, delay);
    };

    return rec;
  }

  function ensureRunning() {
    if (!wantListening || recognizing || document.hidden) return;
    try {
      lastStart = Date.now();
      recognition.start();
      recognizing = true;
    } catch {
      // Déjà démarrée : onend relancera si besoin.
    }
  }

  function armModeTimer(ms) {
    clearTimeout(modeTimer);
    modeTimer = setTimeout(() => {
      if (state !== "listening") return;
      els.transcript.textContent = "";
      chimeOff();
      enterWakeMode();
    }, ms);
  }

  function enterWakeMode() {
    clearTimeout(modeTimer);
    mode = "wake";
    pendingCommand = "";
    setState("idle");
  }

  function enterCommandMode(timeout = COMMAND_TIMEOUT_MS) {
    mode = "command";
    setState("listening");
    if (timeout === COMMAND_TIMEOUT_MS) els.transcript.textContent = "";
    armModeTimer(timeout);
  }

  function startListening(nextMode) {
    wantListening = true;
    if (nextMode === "command") enterCommandMode();
    else if (nextMode === "followup") enterCommandMode(FOLLOW_UP_TIMEOUT_MS);
    else enterWakeMode();
    ensureRunning();
  }

  function stopListening() {
    wantListening = false;
    clearTimeout(modeTimer);
    try {
      recognition?.abort();
    } catch {}
  }

  function stripPunctuation(text) {
    return text.replace(/^[\s,.!?;:'-]+|[\s,;:'-]+$/g, "");
  }

  function onFinal(alternatives) {
    restartDelay = 250;
    if (els.errorBanner.hidden === false && state !== "error") hideError();
    const text = alternatives[0] || "";

    if (mode === "command") {
      const command = stripPunctuation(text.replace(WAKE_RE, " "));
      if (command) handleCommand(command);
      return;
    }

    // Mode veille : chercher « Jarvis » dans toutes les alternatives.
    for (const alt of alternatives) {
      const match = alt.match(WAKE_RE);
      if (!match) continue;
      const rest = stripPunctuation(alt.slice(match.index + match[0].length));
      if (rest.split(/\s+/).filter(Boolean).length >= 2) {
        // « Jarvis, quelle heure est-il ? » en une seule phrase.
        handleCommand(rest);
      } else {
        if (state !== "listening") chimeOn();
        enterCommandMode();
      }
      return;
    }
    if (state === "listening") enterWakeMode(); // fausse détection
  }

  // ---------------------------------------------------------------------------
  // Dialogue avec Claude (via le proxy serveur)
  // ---------------------------------------------------------------------------
  let inflight = null;

  function saveHistory() {
    history = history.slice(-MAX_HISTORY);
    store.set("sessionStorage", "jarvis.history", history);
  }

  async function askJarvis(text) {
    const messages = [...history, { role: "user", content: text }];
    const controller = new AbortController();
    inflight = controller;
    const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
    try {
      const headers = { "Content-Type": "application/json" };
      if (settings.token) headers["X-Jarvis-Token"] = encodeURIComponent(settings.token);
      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok || !data?.reply) {
        const err = new Error(data?.error || `Erreur serveur (${res.status})`);
        err.code = data?.code || "http_" + res.status;
        throw err;
      }
      history.push({ role: "user", content: text }, { role: "assistant", content: data.reply });
      saveHistory();
      return data.reply;
    } catch (err) {
      if (controller.signal.aborted) {
        const e = new Error(controller.signal.reason === "timeout" ? "Délai de réponse dépassé." : "Annulé.");
        e.code = controller.signal.reason === "timeout" ? "timeout" : "cancelled";
        throw e;
      }
      if (!err.code) {
        const e = new Error("Impossible de joindre le serveur Jarvis. Vérifiez votre connexion.");
        e.code = "network";
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (inflight === controller) inflight = null;
    }
  }

  function spokenError(err) {
    switch (err.code) {
      case "network":
        return "Je crains que la connexion avec mes serveurs ne soit interrompue, Monsieur.";
      case "timeout":
        return "Mes serveurs mettent un temps inhabituel à répondre, Monsieur. Veuillez réessayer.";
      case "unauthorized":
        return "Le code d'accès semble incorrect, Monsieur. Vérifiez les réglages.";
      case "token_missing":
        return "Il me faut votre code d'accès, Monsieur. Veuillez le saisir dans les réglages.";
      case "rate_limited":
        return "Je suis momentanément submergé, Monsieur. Accordez-moi un instant.";
      case "config":
        return "Ma configuration serveur est incomplète, Monsieur. La clé d'accès à mes systèmes semble manquante ou invalide.";
      default:
        return "Une anomalie s'est produite dans mes systèmes, Monsieur.";
    }
  }

  async function respond(text) {
    setState("speaking");
    els.reply.textContent = text;
    els.reply.scrollTop = 0;
    await speak(text);
  }

  async function handleCommand(text) {
    stopListening();
    clearTimeout(modeTimer);
    els.transcript.textContent = text;
    els.reply.textContent = "";
    hideError();

    if (CLEAR_RE.test(text)) {
      history = [];
      saveHistory();
      await respond("C'est fait, Monsieur. Je repars d'une page blanche.");
      return afterResponse();
    }

    if (!navigator.onLine) {
      showError("Pas de connexion Internet.", () => startListening("wake"));
      await respond("Nous semblons être hors ligne, Monsieur. Je ne peux rien faire sans réseau.");
      return afterResponse();
    }

    setState("thinking");
    try {
      const reply = await askJarvis(text);
      if (state !== "thinking") return; // annulé entre-temps
      await respond(reply);
    } catch (err) {
      if (err.code === "cancelled") return;
      console.error(err);
      showError(err.message, () => startListening("wake"));
      await respond(spokenError(err));
    }
    afterResponse();
  }

  function afterResponse() {
    if (state !== "speaking") return; // interrompu par l'utilisateur
    // Relance automatique : courte fenêtre pour enchaîner sans dire « Jarvis ».
    startListening("followup");
  }

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  let wakeLock = null;
  async function keepScreenOn() {
    try {
      if ("wakeLock" in navigator && !document.hidden) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {}
  }

  async function boot() {
    hideError();
    if (!Recognition) {
      setState("error");
      showError("Reconnaissance vocale non prise en charge. Utilisez Google Chrome sur Android.");
      return;
    }
    if (!window.isSecureContext) {
      setState("error");
      showError("Le micro nécessite une connexion sécurisée (HTTPS).");
      return;
    }

    // Débloque l'audio (bips + synthèse) grâce au geste de l'utilisateur.
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
    } catch {}

    // Demande explicite du micro pour un message d'erreur clair.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        setState("error");
        if (err.name === "NotAllowedError" || err.name === "SecurityError") {
          showError(
            "Accès au micro refusé. Autorisez-le dans Chrome : icône à gauche de l'adresse › Autorisations › Micro."
          );
        } else if (err.name === "NotFoundError") {
          showError("Aucun micro détecté sur cet appareil.");
        } else {
          showError("Impossible d'accéder au micro : " + err.message);
        }
        return;
      }
    }

    recognition = recognition || createRecognition();
    keepScreenOn();
    refreshVoices();

    if (!initialized) {
      initialized = true;
      await respond(
        history.length
          ? "Rebonjour, Monsieur. Je reprends où nous en étions."
          : "Bonjour, Monsieur. Tous les systèmes sont opérationnels."
      );
      if (state !== "speaking") return; // l'utilisateur a déjà repris la main
    }
    startListening("wake");
  }

  // Le réacteur sert de bouton principal selon l'état.
  els.reactor.addEventListener("click", () => {
    switch (state) {
      case "offline":
      case "error":
        hideError();
        if (!initialized || !recognition) boot();
        else startListening("wake");
        break;
      case "idle":
        chimeOn();
        startListening("command");
        break;
      case "listening":
        chimeOff();
        enterWakeMode();
        break;
      case "thinking":
        inflight?.abort();
        startListening("wake");
        break;
      case "speaking":
        stopSpeaking();
        chimeOn();
        startListening("command");
        break;
    }
  });

  // Chrome coupe le micro quand l'app passe en arrière-plan : on reprend au retour.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (recognizing) {
        try {
          recognition.abort();
        } catch {}
      }
      return;
    }
    keepScreenOn();
    if (initialized && wantListening) ensureRunning();
  });

  window.addEventListener("online", () => {
    if (initialized && state === "idle") hideError();
  });
  window.addEventListener("offline", () => {
    if (initialized) showError("Connexion Internet perdue.", () => startListening("wake"));
  });

  // ---------------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------------
  function saveSettings() {
    store.set("localStorage", "jarvis.settings", settings);
  }

  function syncSettingsUI() {
    els.rate.value = settings.rate;
    els.pitch.value = settings.pitch;
    els.rateOut.textContent = Number(settings.rate).toFixed(2);
    els.pitchOut.textContent = Number(settings.pitch).toFixed(2);
    els.token.value = settings.token;
  }

  els.settingsBtn.addEventListener("click", () => {
    refreshVoices();
    syncSettingsUI();
    els.settings.showModal();
  });
  els.voiceSelect.addEventListener("change", () => {
    settings.voiceURI = els.voiceSelect.value;
    saveSettings();
  });
  els.rate.addEventListener("input", () => {
    settings.rate = Number(els.rate.value);
    els.rateOut.textContent = settings.rate.toFixed(2);
    saveSettings();
  });
  els.pitch.addEventListener("input", () => {
    settings.pitch = Number(els.pitch.value);
    els.pitchOut.textContent = settings.pitch.toFixed(2);
    saveSettings();
  });
  els.token.addEventListener("input", () => {
    settings.token = els.token.value.trim();
    saveSettings();
  });
  els.testVoice.addEventListener("click", () => {
    speak("À votre service, Monsieur. Voici ma voix actuelle.");
  });
  els.clearHistory.addEventListener("click", () => {
    history = [];
    saveHistory();
    els.transcript.textContent = "";
    els.reply.textContent = "";
    els.clearHistory.textContent = "Effacée ✓";
    setTimeout(() => (els.clearHistory.textContent = "Effacer la conversation"), 1500);
  });

  // ---------------------------------------------------------------------------
  // Service worker (installation sur l'écran d'accueil + hors ligne)
  // ---------------------------------------------------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker :", err));
    });
  }

  setState("offline");
})();
