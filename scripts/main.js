/**
 * Mesa de Câmeras — Foundry VTT v12 / v13
 * Coloca as câmeras dos usuários atrás das áreas transparentes de uma arte PNG.
 */

const MOD = "mesa-de-cameras";
const POLL_MS = 700;

/* -------------------------------------------- */
/*  Configuração                                */
/* -------------------------------------------- */

const DEFAULT_CONFIG = { image: "", fit: "contain", slots: [] };

function getConfig() {
  const cfg = game.settings.get(MOD, "config") ?? {};
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), cfg, { inplace: false });
}

async function setConfig(cfg) {
  return game.settings.set(MOD, "config", cfg);
}

function isActive() {
  return game.settings.get(MOD, "ativa") && !game.settings.get(MOD, "ocultarParaMim");
}

/* -------------------------------------------- */
/*  Detecção das áreas transparentes            */
/* -------------------------------------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Não consegui carregar a imagem: ${src}`));
    img.src = src;
  });
}

/**
 * Encontra regiões conectadas de pixels transparentes e devolve retângulos
 * normalizados (0–1) ordenados em ordem de leitura.
 */
async function detectSlots(src) {
  const img = await loadImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  const N = W * H;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = data[i * 4 + 3] < 128 ? 1 : 0;

  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  const minArea = N * 0.002;
  const regions = [];

  for (let start = 0; start < N; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0, area = 0;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // Ignora ruído e faixas finas (bordas da imagem, por exemplo)
    if (area < minArea || w < W * 0.02 || h < H * 0.02) continue;
    regions.push({ x0, y0, w, h });
  }

  // Ordem de leitura: linhas (por centro vertical), depois esquerda → direita
  regions.sort((a, b) => {
    const ca = a.y0 + a.h / 2, cb = b.y0 + b.h / 2;
    if (Math.abs(ca - cb) > Math.min(a.h, b.h) / 2) return ca - cb;
    return a.x0 - b.x0;
  });

  const bleed = 2; // px extras pra não sobrar fresta
  return regions.map((r, i) => ({
    id: foundry.utils.randomID(),
    x: Math.max(0, (r.x0 - bleed) / W),
    y: Math.max(0, (r.y0 - bleed) / H),
    w: Math.min(1, (r.w + bleed * 2) / W),
    h: Math.min(1, (r.h + bleed * 2) / H),
    user: null
  }));
}

/* -------------------------------------------- */
/*  Estado de câmera / stream                   */
/* -------------------------------------------- */

function dockViewFor(userId) {
  return document.querySelector(`#camera-views [data-user="${userId}"]`)
    ?? document.querySelector(`.camera-view[data-user="${userId}"]`);
}

function streamFor(userId) {
  let stream = null;
  try { stream = game.webrtc?.client?.getMediaStreamForUser?.(userId) ?? null; } catch (e) { /* ignora */ }
  if (!stream) {
    const v = dockViewFor(userId)?.querySelector("video");
    if (v?.srcObject) stream = v.srcObject;
  }
  if (!stream && userId === game.user.id) {
    try { stream = game.webrtc?.client?.localStream ?? null; } catch (e) { /* ignora */ }
  }
  return stream;
}

function rtcUser(userId) {
  try { return game.webrtc?.settings?.getUser?.(userId) ?? null; } catch (e) { return null; }
}

function cameraOffByFlag(user) {
  return !!user?.getFlag?.(MOD, "cameraOff");
}

function hasLiveVideo(stream) {
  return !!stream?.getVideoTracks?.().some(t => t.readyState === "live");
}

function videoVisible(user, stream) {
  if (!user?.active) return false;
  if (cameraOffByFlag(user)) return false;
  const rs = rtcUser(user.id);
  if (rs?.hidden) return false;
  if (rs && rs.canBroadcastVideo === false) return false;
  if (dockViewFor(user.id)?.classList.contains("no-video")) return false;
  return hasLiveVideo(stream);
}

function fallbackImage(user) {
  return user?.character?.img || user?.avatar || "icons/svg/mystery-man.svg";
}

/* -------------------------------------------- */
/*  Controles do próprio jogador                */
/* -------------------------------------------- */

function setLocalVideoTrack(enabled) {
  const client = game.webrtc?.client;
  try {
    if (typeof client?.toggleVideo === "function") client.toggleVideo(enabled);
  } catch (e) { /* ignora */ }
  const s = streamFor(game.user.id);
  s?.getVideoTracks?.().forEach(t => { t.enabled = enabled; });
}

async function toggleMyCamera() {
  const off = !cameraOffByFlag(game.user);
  await game.user.setFlag(MOD, "cameraOff", off);
  setLocalVideoTrack(!off);
  Overlay.refresh();
}

function isMyMicMuted() {
  const rs = rtcUser(game.user.id);
  if (rs && typeof rs.muted === "boolean") return rs.muted;
  const s = streamFor(game.user.id);
  const tracks = s?.getAudioTracks?.() ?? [];
  return tracks.length ? tracks.every(t => !t.enabled) : false;
}

async function toggleMyMic() {
  const muted = !isMyMicMuted();
  try {
    await game.webrtc.settings.set("client", `users.${game.user.id}.muted`, muted);
  } catch (e) {
    streamFor(game.user.id)?.getAudioTracks?.().forEach(t => { t.enabled = !muted; });
  }
  Overlay.refresh();
}

/* -------------------------------------------- */
/*  Overlay                                     */
/* -------------------------------------------- */

const Overlay = {
  root: null,
  stage: null,
  art: null,
  slotEls: new Map(),
  timer: null,
  imgSize: { w: 1920, h: 1080 },

  async build() {
    this.destroy();
    const cfg = getConfig();
    document.body.classList.toggle("mdc-active", isActive() && !!cfg.image);
    document.body.classList.toggle("mdc-hide-dock", isActive() && !!cfg.image && game.settings.get(MOD, "esconderDock"));
    if (!isActive() || !cfg.image) return;

    const root = document.createElement("div");
    root.id = "mdc-overlay";
    const stage = document.createElement("div");
    stage.className = "mdc-stage";
    root.appendChild(stage);

    for (const slot of cfg.slots) {
      const el = document.createElement("div");
      el.className = "mdc-slot";
      el.dataset.slot = slot.id;
      Object.assign(el.style, {
        left: `${slot.x * 100}%`, top: `${slot.y * 100}%`,
        width: `${slot.w * 100}%`, height: `${slot.h * 100}%`
      });
      const video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      const fb = document.createElement("img");
      fb.className = "mdc-fallback";
      el.append(video, fb);
      stage.appendChild(el);

      const ctrl = document.createElement("div");
      ctrl.className = "mdc-controls";
      ctrl.dataset.slot = slot.id;
      ctrl.style.cssText = el.style.cssText;
      ctrl.innerHTML = `
        <div class="mdc-buttons">
          <button type="button" data-act="cam" title="Ligar/desligar minha câmera"><i class="fas fa-video"></i></button>
          <button type="button" data-act="mic" title="Ligar/desligar meu microfone"><i class="fas fa-microphone"></i></button>
        </div>`;
      ctrl.addEventListener("click", ev => {
        const act = ev.target.closest("button")?.dataset.act;
        if (act === "cam") toggleMyCamera();
        if (act === "mic") toggleMyMic();
      });
      stage.appendChild(ctrl);

      this.slotEls.set(slot.id, { el, video, fb, ctrl, slot });
    }

    const art = document.createElement("img");
    art.className = "mdc-art";
    art.src = cfg.image;
    art.addEventListener("load", () => {
      this.imgSize = { w: art.naturalWidth, h: art.naturalHeight };
      this.layout();
    });
    stage.appendChild(art);

    const board = document.getElementById("board");
    if (board?.parentElement) board.insertAdjacentElement("afterend", root);
    else document.body.prepend(root);

    this.root = root; this.stage = stage; this.art = art;
    this.fit = cfg.fit;
    this.layout();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  },

  layout() {
    if (!this.stage) return;
    const W = window.innerWidth, H = window.innerHeight;
    const { w, h } = this.imgSize;
    const s = this.fit === "cover" ? Math.max(W / w, H / h)
      : this.fit === "stretch" ? null : Math.min(W / w, H / h);
    const sw = s ? w * s : W, sh = s ? h * s : H;
    Object.assign(this.stage.style, {
      width: `${sw}px`, height: `${sh}px`,
      left: `${(W - sw) / 2}px`, top: `${(H - sh) / 2}px`
    });
  },

  refresh() {
    if (!this.root) return;
    for (const { el, video, fb, ctrl, slot } of this.slotEls.values()) {
      const user = slot.user ? game.users.get(slot.user) : null;
      if (!user) {
        el.classList.add("mdc-empty");
        ctrl.classList.remove("mdc-mine");
        if (video.srcObject) video.srcObject = null;
        continue;
      }
      el.classList.remove("mdc-empty");
      const mine = user.id === game.user.id;
      ctrl.classList.toggle("mdc-mine", mine);

      // Mantém a trilha local desligada se o jogador desligou pela mesa
      if (mine && cameraOffByFlag(user)) {
        streamFor(user.id)?.getVideoTracks?.().forEach(t => { if (t.enabled) t.enabled = false; });
      }

      const stream = streamFor(user.id);
      const show = videoVisible(user, stream);
      if (show && video.srcObject !== stream) {
        video.srcObject = stream;
        video.play?.().catch(() => {});
      }
      if (!show && video.srcObject) video.srcObject = null;
      el.classList.toggle("mdc-novideo", !show);
      const src = fallbackImage(user);
      if (fb.getAttribute("src") !== src) fb.setAttribute("src", src);
      // Espelha a própria câmera, como o Foundry faz
      video.classList.toggle("mdc-mirror", mine);

      if (mine) {
        ctrl.querySelector('[data-act="cam"]')?.classList.toggle("mdc-off", cameraOffByFlag(user));
        ctrl.querySelector('[data-act="mic"]')?.classList.toggle("mdc-off", isMyMicMuted());
        const camIcon = ctrl.querySelector('[data-act="cam"] i');
        if (camIcon) camIcon.className = cameraOffByFlag(user) ? "fas fa-video-slash" : "fas fa-video";
        const micIcon = ctrl.querySelector('[data-act="mic"] i');
        if (micIcon) micIcon.className = isMyMicMuted() ? "fas fa-microphone-slash" : "fas fa-microphone";
      }
    }
  },

  destroy() {
    clearInterval(this.timer); this.timer = null;
    for (const { video } of this.slotEls.values()) video.srcObject = null;
    this.slotEls.clear();
    this.root?.remove();
    this.root = this.stage = this.art = null;
  }
};

/* -------------------------------------------- */
/*  Editor (só GM)                              */
/* -------------------------------------------- */

const Editor = {
  el: null,
  cfg: null,
  selected: null,

  open() {
    if (!game.user.isGM) return ui.notifications.warn("Só o GM pode configurar a Mesa de Câmeras.");
    this.close();
    this.cfg = getConfig();
    const el = document.createElement("div");
    el.id = "mdc-editor";
    el.innerHTML = `
      <div class="mdc-ed-window">
        <header>
          <h2><i class="fas fa-photo-film"></i> Mesa de Câmeras</h2>
          <button type="button" class="mdc-ed-close" title="Fechar"><i class="fas fa-times"></i></button>
        </header>
        <div class="mdc-ed-toolbar">
          <label>Arte (PNG)
            <span class="mdc-ed-row">
              <input type="text" name="image" placeholder="caminho/da/imagem.png">
              <button type="button" data-act="browse" title="Procurar"><i class="fas fa-folder-open"></i></button>
            </span>
          </label>
          <label>Ajuste na tela
            <select name="fit">
              <option value="contain">Caber inteira (com bordas)</option>
              <option value="cover">Preencher (pode cortar)</option>
              <option value="stretch">Esticar</option>
            </select>
          </label>
          <div class="mdc-ed-actions">
            <button type="button" data-act="detect"><i class="fas fa-wand-magic-sparkles"></i> Detectar áreas</button>
            <button type="button" data-act="add"><i class="fas fa-plus"></i> Adicionar área</button>
          </div>
        </div>
        <div class="mdc-ed-canvas"><div class="mdc-ed-stage"></div></div>
        <p class="mdc-ed-hint">Arraste uma área para mover; use o canto inferior direito para redimensionar. Escolha quem fica em cada área no menu dela.</p>
        <footer>
          <label class="mdc-ed-check"><input type="checkbox" name="ativa"> Mesa ativa para todos</label>
          <span class="mdc-ed-spacer"></span>
          <button type="button" data-act="cancel">Cancelar</button>
          <button type="button" data-act="save" class="mdc-primary"><i class="fas fa-save"></i> Salvar</button>
        </footer>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    el.querySelector('[name="image"]').value = this.cfg.image;
    el.querySelector('[name="fit"]').value = this.cfg.fit;
    el.querySelector('[name="ativa"]').checked = game.settings.get(MOD, "ativa");

    el.querySelector('[name="image"]').addEventListener("change", ev => this.setImage(ev.target.value.trim(), false));
    el.querySelector(".mdc-ed-close").addEventListener("click", () => this.close());
    el.addEventListener("click", ev => {
      const act = ev.target.closest("button[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "browse") this.browse();
      else if (act === "detect") this.detect();
      else if (act === "add") this.addSlot();
      else if (act === "cancel") this.close();
      else if (act === "save") this.save();
    });

    this._onResize = () => this.renderStage();
    window.addEventListener("resize", this._onResize);
    this.renderStage();
  },

  close() {
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    this.el?.remove();
    this.el = null;
  },

  browse() {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    this.el.style.display = "none";
    const picker = new FP({
      type: "image",
      current: this.cfg.image,
      callback: path => { this.el.style.display = ""; this.setImage(path, true); }
    });
    picker.render(true);
    // Se o picker for fechado sem escolher, mostra o editor de novo
    const watch = setInterval(() => {
      if (!this.el) return clearInterval(watch);
      if (this.el.style.display !== "none") return clearInterval(watch);
      const open = picker.rendered ?? picker._state > 0;
      if (open === false) { this.el.style.display = ""; clearInterval(watch); }
    }, 400);
  },

  async setImage(path, autoDetect) {
    this.cfg.image = path;
    this.el.querySelector('[name="image"]').value = path;
    if (autoDetect && path) await this.detect(true);
    else this.renderStage();
  },

  async detect(quiet = false) {
    if (!this.cfg.image) return ui.notifications.warn("Escolha uma imagem primeiro.");
    try {
      const found = await detectSlots(this.cfg.image);
      // Reaproveita os jogadores já escolhidos, pela ordem
      const prevUsers = this.cfg.slots.map(s => s.user);
      found.forEach((s, i) => { s.user = prevUsers[i] ?? null; });
      this.cfg.slots = found;
      this.renderStage();
      if (!found.length) ui.notifications.warn("Não achei áreas transparentes nessa imagem. Você pode adicionar áreas manualmente.");
      else if (!quiet) ui.notifications.info(`${found.length} área(s) encontrada(s).`);
      else ui.notifications.info(`${found.length} área(s) encontrada(s) na imagem.`);
    } catch (e) {
      console.error(e);
      ui.notifications.error(e.message);
    }
  },

  addSlot() {
    this.cfg.slots.push({ id: foundry.utils.randomID(), x: 0.4, y: 0.4, w: 0.2, h: 0.2, user: null });
    this.renderStage();
  },

  renderStage() {
    if (!this.el) return;
    const wrap = this.el.querySelector(".mdc-ed-canvas");
    const stage = this.el.querySelector(".mdc-ed-stage");
    stage.innerHTML = "";
    if (!this.cfg.image) {
      stage.style.width = "100%"; stage.style.height = "100%";
      stage.innerHTML = `<div class="mdc-ed-empty">Escolha a arte PNG para começar.</div>`;
      return;
    }
    const img = document.createElement("img");
    img.src = this.cfg.image;
    img.className = "mdc-ed-img";
    stage.appendChild(img);

    const size = () => {
      const W = wrap.clientWidth, H = wrap.clientHeight;
      const iw = img.naturalWidth || 16, ih = img.naturalHeight || 9;
      const s = Math.min(W / iw, H / ih);
      stage.style.width = `${iw * s}px`;
      stage.style.height = `${ih * s}px`;
    };
    if (img.complete) size(); else img.addEventListener("load", size);

    const userOptions = [`<option value="">— vazio —</option>`]
      .concat(game.users.map(u => `<option value="${u.id}">${foundry.utils.escapeHTML?.(u.name) ?? u.name}${u.isGM ? " (GM)" : ""}</option>`))
      .join("");

    this.cfg.slots.forEach((slot, i) => {
      const box = document.createElement("div");
      box.className = "mdc-ed-slot";
      box.dataset.id = slot.id;
      this.placeBox(box, slot);
      box.innerHTML = `
        <span class="mdc-ed-num">${i + 1}</span>
        <button type="button" class="mdc-ed-del" title="Remover área"><i class="fas fa-trash"></i></button>
        <select class="mdc-ed-user">${userOptions}</select>
        <span class="mdc-ed-handle"></span>`;
      const sel = box.querySelector("select");
      sel.value = slot.user ?? "";
      sel.addEventListener("change", () => { slot.user = sel.value || null; });
      sel.addEventListener("pointerdown", ev => ev.stopPropagation());
      box.querySelector(".mdc-ed-del").addEventListener("pointerdown", ev => ev.stopPropagation());
      box.querySelector(".mdc-ed-del").addEventListener("click", () => {
        this.cfg.slots = this.cfg.slots.filter(s => s.id !== slot.id);
        this.renderStage();
      });
      box.addEventListener("pointerdown", ev => this.startDrag(ev, box, slot, stage));
      stage.appendChild(box);
    });
  },

  placeBox(box, slot) {
    Object.assign(box.style, {
      left: `${slot.x * 100}%`, top: `${slot.y * 100}%`,
      width: `${slot.w * 100}%`, height: `${slot.h * 100}%`
    });
  },

  startDrag(ev, box, slot, stage) {
    ev.preventDefault();
    const resize = ev.target.classList.contains("mdc-ed-handle");
    const rect = stage.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY;
    const o = { ...slot };
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const move = e => {
      const dx = (e.clientX - sx) / rect.width, dy = (e.clientY - sy) / rect.height;
      if (resize) {
        slot.w = clamp(o.w + dx, 0.02, 1 - o.x);
        slot.h = clamp(o.h + dy, 0.02, 1 - o.y);
      } else {
        slot.x = clamp(o.x + dx, 0, 1 - o.w);
        slot.y = clamp(o.y + dy, 0, 1 - o.h);
      }
      this.placeBox(box, slot);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  },

  async save() {
    this.cfg.fit = this.el.querySelector('[name="fit"]').value;
    this.cfg.image = this.el.querySelector('[name="image"]').value.trim();
    const ativa = this.el.querySelector('[name="ativa"]').checked;
    await setConfig(this.cfg);
    if (game.settings.get(MOD, "ativa") !== ativa) await game.settings.set(MOD, "ativa", ativa);
    ui.notifications.info("Mesa de Câmeras salva.");
    this.close();
  }
};

/* -------------------------------------------- */
/*  Menu de configurações                       */
/* -------------------------------------------- */

function makeMenuClass() {
  const Base = foundry.applications?.api?.ApplicationV2 ?? FormApplication;
  return class MesaDeCamerasMenu extends Base {
    render() { Editor.open(); return this; }
  };
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const rebuild = () => Overlay.build();

  game.settings.register(MOD, "config", {
    scope: "world", config: false, type: Object, default: DEFAULT_CONFIG,
    onChange: rebuild
  });
  game.settings.register(MOD, "ativa", {
    name: "Mesa ativa",
    hint: "Liga a mesa para todos os jogadores.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: rebuild
  });
  game.settings.register(MOD, "esconderDock", {
    name: "Esconder o dock de câmeras padrão",
    hint: "Enquanto a mesa estiver ativa, o dock normal do Foundry fica invisível. O áudio continua funcionando.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: rebuild
  });
  game.settings.register(MOD, "ocultarParaMim", {
    name: "Ocultar a mesa só para mim",
    hint: "Esconde a mesa apenas neste computador.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: rebuild
  });

  game.settings.registerMenu(MOD, "editor", {
    name: "Configurar mesa",
    label: "Abrir editor",
    hint: "Escolher a arte, detectar as áreas transparentes e definir quem fica em cada uma.",
    icon: "fas fa-photo-film",
    type: makeMenuClass(),
    restricted: true
  });

  game.keybindings.register(MOD, "toggle", {
    name: "Ligar/desligar a mesa (GM)",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { game.settings.set(MOD, "ativa", !game.settings.get(MOD, "ativa")); return true; }
  });
});

Hooks.once("ready", () => {
  window.addEventListener("resize", () => Overlay.layout());
  Overlay.build();

  // Se o jogador tinha deixado a câmera desligada, mantém desligada
  if (cameraOffByFlag(game.user)) setTimeout(() => setLocalVideoTrack(false), 2000);

  game.modules.get(MOD).api = {
    openEditor: () => Editor.open(),
    toggle: () => game.user.isGM && game.settings.set(MOD, "ativa", !game.settings.get(MOD, "ativa")),
    toggleMyCamera,
    toggleMyMic,
    detectSlots
  };
});

Hooks.on("updateUser", (user, changes) => {
  if (changes.flags?.[MOD] || "character" in changes || "avatar" in changes || "active" in changes) Overlay.refresh();
});
Hooks.on("rtcSettingsChanged", () => Overlay.refresh());
Hooks.on("renderCameraViews", () => Overlay.refresh());

// Botão nos controles da cena (GM): v12 usa array, v13 usa objeto
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const active = game.settings.get(MOD, "ativa");
  if (Array.isArray(controls)) {
    const token = controls.find(c => c.name === "token");
    if (!token) return;
    token.tools.push(
      { name: "mdc-toggle", title: "Mesa de Câmeras: ligar/desligar", icon: "fas fa-photo-film",
        toggle: true, active, onClick: on => game.settings.set(MOD, "ativa", on) },
      { name: "mdc-editor", title: "Mesa de Câmeras: configurar", icon: "fas fa-sliders",
        button: true, onClick: () => Editor.open() }
    );
  } else {
    const token = controls.tokens ?? controls.token;
    if (!token?.tools) return;
    const n = Object.keys(token.tools).length;
    token.tools["mdc-toggle"] = {
      name: "mdc-toggle", title: "Mesa de Câmeras: ligar/desligar", icon: "fas fa-photo-film",
      order: n + 1, toggle: true, active,
      onChange: (event, on) => game.settings.set(MOD, "ativa", on)
    };
    token.tools["mdc-editor"] = {
      name: "mdc-editor", title: "Mesa de Câmeras: configurar", icon: "fas fa-sliders",
      order: n + 2, button: true,
      onChange: () => Editor.open()
    };
  }
});
