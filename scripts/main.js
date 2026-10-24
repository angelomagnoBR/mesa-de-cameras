/**
 * Mesa de Câmeras — Foundry VTT v12 / v13
 * Coloca as câmeras dos usuários atrás das áreas transparentes da imagem de fundo da cena.
 */

const MOD = "mesa-de-cameras";
const POLL_MS = 700;

/* -------------------------------------------- */
/*  Configuração                                */
/* -------------------------------------------- */

/** Configuração da mesa guardada na própria cena. */
function sceneCfg(scene = canvas?.scene) {
  const f = scene?.getFlag?.(MOD, "mesa") ?? {};
  return { ativa: !!f.ativa, slots: foundry.utils.deepClone(f.slots ?? []) };
}

async function setSceneCfg(scene, cfg) {
  return scene.update({ [`flags.${MOD}.mesa`]: { ativa: !!cfg.ativa, slots: cfg.slots } });
}

/** A arte da mesa é a imagem de fundo da cena. */
function sceneImage(scene = canvas?.scene) {
  return scene?.background?.src ?? scene?.img ?? "";
}

function isActive() {
  const scene = canvas?.scene;
  return !!scene && sceneCfg(scene).ativa && !!sceneImage(scene) && !game.settings.get(MOD, "ocultarParaMim");
}

async function toggleSceneMesa(on) {
  const scene = canvas?.scene;
  if (!scene || !game.user.isGM) return;
  const cfg = sceneCfg(scene);
  cfg.ativa = on ?? !cfg.ativa;
  if (cfg.ativa && !cfg.slots.length) {
    ui.notifications.warn("Mesa de Câmeras: configure as áreas desta cena primeiro.");
    return Editor.open();
  }
  await setSceneCfg(scene, cfg);
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

  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const minArea = N * 0.002;
  const regions = [];
  let nextId = 0;

  for (let start = 0; start < N; start++) {
    if (!mask[start] || label[start]) continue;
    const id = ++nextId;
    let sp = 0, area = 0;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[sp++] = start; label[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !label[p - W]) { label[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !label[p + W]) { label[p + W] = id; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // Ignora ruído e faixas finas (bordas da imagem, por exemplo)
    if (area < minArea || w < W * 0.02 || h < H * 0.02) continue;
    regions.push({ x0, y0, w, h, ...fitRotatedRect(label, id, W, H, x0, y0, x1, y1) });
  }

  // Ordem de leitura: linhas (por centro vertical), depois esquerda → direita
  regions.sort((a, b) => {
    const ca = a.y0 + a.h / 2, cb = b.y0 + b.h / 2;
    if (Math.abs(ca - cb) > Math.min(a.h, b.h) / 2) return ca - cb;
    return a.x0 - b.x0;
  });

  const bleed = 3; // px extras pra não sobrar fresta
  return regions.map(r => {
    const a = r.a + bleed * 2, b = r.b + bleed * 2;
    return {
      id: foundry.utils.randomID(),
      x: (r.cx - a / 2) / W,
      y: (r.cy - b / 2) / H,
      w: a / W,
      h: b / H,
      rot: r.rot,
      user: null
    };
  });
}

/**
 * Menor retângulo girado (entre -20° e 20°) que cobre todos os pixels da região.
 * Ângulo em graus, sentido horário (igual ao CSS rotate).
 */
function fitRotatedRect(label, id, W, H, x0, y0, x1, y1) {
  // Só os pixels de borda bastam para o envoltório
  const xs = [], ys = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * W + x;
      if (label[p] !== id) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1
        || label[p - 1] !== id || label[p + 1] !== id || label[p - W] !== id || label[p + W] !== id) {
        xs.push(x + 0.5); ys.push(y + 0.5);
      }
    }
  }
  const n = xs.length;
  const measure = deg => {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = xs[i] * c + ys[i] * s, v = -xs[i] * s + ys[i] * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    return {
      area: (u1 - u0 + 1) * (v1 - v0 + 1),
      a: u1 - u0 + 1, b: v1 - v0 + 1,
      cx: uc * c - vc * s, cy: uc * s + vc * c, rot: deg
    };
  };
  let best = measure(0);
  for (let d = -20; d <= 20; d += 0.25) {
    const m = measure(d);
    if (m.area < best.area) best = m;
  }
  // Refino fino em volta do melhor
  for (let d = best.rot - 0.25; d <= best.rot + 0.25; d += 0.05) {
    const m = measure(d);
    if (m.area < best.area) best = m;
  }
  // Se quase não muda nada, prefere reto
  const flat = measure(0);
  if (flat.area <= best.area * 1.01) best = flat;
  best.rot = Math.round(best.rot * 100) / 100;
  return best;
}

/* -------------------------------------------- */
/*  Estado de câmera / stream                   */
/* -------------------------------------------- */

function dockViewFor(userId) {
  return document.querySelector(`#camera-views [data-user="${userId}"]`)
    ?? document.querySelector(`.camera-view[data-user="${userId}"]`);
}

function dockVideoFor(userId) {
  const view = dockViewFor(userId);
  if (!view) return null;
  if (view instanceof HTMLVideoElement) return view;
  return view.querySelector("video.user-video") ?? view.querySelector("video.user-camera") ?? view.querySelector("video");
}

/** Cliente do LiveKit (módulo avclient-livekit), se estiver em uso. */
function liveKit() {
  return game.webrtc?.client?._liveKitClient ?? null;
}

function liveKitTrackFor(userId) {
  try { return liveKit()?.getUserVideoTrack?.(userId) ?? null; } catch (e) { return null; }
}

const isLive = t => !!t && t.readyState === "live";

/**
 * Devolve a trilha de vídeo (MediaStreamTrack) do usuário.
 * A mesa monta o próprio MediaStream com ela, em vez de reaproveitar o do dock:
 * o LiveKit remove a trilha do stream do dock sempre que redesenha as câmeras.
 */
function videoTrackFor(userId) {
  const lk = liveKitTrackFor(userId)?.mediaStreamTrack;
  if (isLive(lk)) return lk;
  const dock = dockVideoFor(userId)?.srcObject;
  const fromDock = dock?.getVideoTracks?.().find(isLive);
  if (fromDock) return fromDock;
  try {
    const s = game.webrtc?.client?.getMediaStreamForUser?.(userId);
    const t = s?.getVideoTracks?.().find(isLive);
    if (t) return t;
  } catch (e) { /* ignora */ }
  if (userId === game.user.id) {
    try {
      const t = game.webrtc?.client?.localStream?.getVideoTracks?.().find(isLive);
      if (t) return t;
    } catch (e) { /* ignora */ }
  }
  return null;
}

/** Stream local (para ligar/desligar a própria câmera e microfone). */
function streamFor(userId) {
  const dock = dockVideoFor(userId)?.srcObject;
  if (dock instanceof MediaStream) return dock;
  try { return game.webrtc?.client?.getMediaStreamForUser?.(userId) ?? game.webrtc?.client?.localStream ?? null; }
  catch (e) { return null; }
}

function rtcUser(userId) {
  try { return game.webrtc?.settings?.getUser?.(userId) ?? null; } catch (e) { return null; }
}

function cameraOffByFlag(user) {
  return !!user?.getFlag?.(MOD, "cameraOff");
}

function videoVisible(user, track) {
  if (!user?.active) return false;
  if (cameraOffByFlag(user)) return false;
  const rs = rtcUser(user.id);
  if (rs?.hidden) return false;
  if (rs && rs.canBroadcastVideo === false) return false;
  const view = dockViewFor(user.id);
  if (view && !(view instanceof HTMLVideoElement) && view.classList.contains("no-video")) return false;
  return isLive(track);
}

/**
 * Integração com o "adaptive stream" do LiveKit: avisa que a foto da mesa está
 * na tela e qual o tamanho dela. Assim o LiveKit não pausa o vídeo quando o dock
 * está escondido e manda a qualidade certa para o tamanho da polaroid.
 */
function liveKitObserve(slotData, userId) {
  const lkTrack = liveKitTrackFor(userId);
  if (slotData.lkTrack === lkTrack) return;
  liveKitUnobserve(slotData);
  if (!lkTrack || typeof lkTrack.observeElementInfo !== "function") return;
  const { video } = slotData;
  const info = {
    element: video,
    visibilityChangedAt: 0,
    pictureInPicture: false,
    // "Visível" = a foto quer mostrar o vídeo. Não pode depender de já haver imagem:
    // com o adaptive stream, o LiveKit só manda o vídeo depois que alguém diz que
    // ele está visível (senão quem entra depois nunca recebe a câmera de quem já estava).
    get visible() { return !!slotData.wanted; },
    width: () => Math.round((slotData.w || 0) * (canvas?.stage?.scale?.x || 1)),
    height: () => Math.round((slotData.h || 0) * (canvas?.stage?.scale?.y || 1)),
    observe() {},
    stopObserving() {}
  };
  try {
    lkTrack.observeElementInfo(info);
    slotData.lkTrack = lkTrack;
    slotData.lkInfo = info;
  } catch (e) {
    console.warn(`${MOD} | não consegui registrar no LiveKit`, e);
  }
}

function liveKitUnobserve(slotData) {
  try { slotData.lkTrack?.stopObservingElementInfo?.(slotData.lkInfo); } catch (e) { /* ignora */ }
  slotData.lkTrack = null;
  slotData.lkInfo = null;
  slotData.lkVisible = undefined;
}

/**
 * Imagem mostrada quando a câmera está desligada, nesta ordem:
 * 1. a imagem que o próprio jogador escolheu para esta cena;
 * 2. a imagem que o GM escolheu para a foto no editor;
 * 3. a imagem do personagem vinculado; 4. o avatar do jogador.
 */
function fallbackImage(user, slot, scene = canvas?.scene) {
  const own = scene ? user?.getFlag?.(MOD, "imagens")?.[scene.id] : null;
  return own || slot?.img || user?.character?.img || user?.avatar || "icons/svg/mystery-man.svg";
}

/** Abre o seletor de arquivos do Foundry e devolve o caminho escolhido (ou null). */
function pickFile(current, hideEl) {
  return new Promise(resolve => {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FP) return resolve(null);
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      if (hideEl) hideEl.style.display = "";
      resolve(v);
    };
    if (hideEl) hideEl.style.display = "none";
    const picker = new FP({ type: "image", current: current || "", callback: path => finish(path) });
    picker.render(true);
    const watch = setInterval(() => {
      if (done) return clearInterval(watch);
      const open = picker.rendered ?? (picker._state > 0);
      if (open === false) { clearInterval(watch); setTimeout(() => finish(null), 300); }
    }, 400);
  });
}

/** Janela para o jogador escolher a imagem que aparece com a câmera desligada. */
function openMyImageDialog() {
  const scene = canvas?.scene;
  if (!scene) return;
  document.getElementById("mdc-imgdlg")?.remove();
  const current = game.user.getFlag(MOD, "imagens")?.[scene.id] ?? "";
  const canBrowse = game.user.can?.("FILES_BROWSE");
  const el = document.createElement("div");
  el.id = "mdc-imgdlg";
  el.innerHTML = `
    <div class="mdc-dlg">
      <h3><i class="fas fa-image"></i> Imagem com a câmera desligada</h3>
      <p>Vale só para esta cena. Sem imagem escolhida, aparece a do GM ou a do seu personagem.</p>
      <div class="mdc-dlg-preview"><img alt=""></div>
      <div class="mdc-dlg-row">
        <input type="text" name="img" placeholder="caminho ou link da imagem">
        ${canBrowse ? `<button type="button" data-act="browse" title="Procurar"><i class="fas fa-folder-open"></i></button>` : ""}
      </div>
      <footer>
        <button type="button" data-act="clear">Usar padrão</button>
        <span class="mdc-ed-spacer"></span>
        <button type="button" data-act="cancel">Cancelar</button>
        <button type="button" data-act="save" class="mdc-primary">Salvar</button>
      </footer>
    </div>`;
  document.body.appendChild(el);
  const input = el.querySelector('[name="img"]');
  const prev = el.querySelector(".mdc-dlg-preview img");
  const show = () => { prev.src = input.value.trim() || fallbackImage(game.user, null, null); };
  input.value = current;
  show();
  input.addEventListener("input", show);
  input.addEventListener("keydown", ev => ev.stopPropagation());
  el.addEventListener("click", async ev => {
    const act = ev.target.closest("button[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "browse") {
      const path = await pickFile(input.value, el);
      if (path) { input.value = path; show(); }
    } else if (act === "cancel") el.remove();
    else if (act === "clear") {
      await game.user.update({ [`flags.${MOD}.imagens.-=${scene.id}`]: null });
      el.remove();
    } else if (act === "save") {
      const v = input.value.trim();
      if (v) await game.user.update({ [`flags.${MOD}.imagens.${scene.id}`]: v });
      else await game.user.update({ [`flags.${MOD}.imagens.-=${scene.id}`]: null });
      el.remove();
    }
  });
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
/*  Mesa dentro do canvas                       */
/* -------------------------------------------- */

/*
 * As câmeras são desenhadas DENTRO do canvas do Foundry, numa camada logo
 * abaixo da imagem de fundo da cena. Os buracos transparentes do fundo deixam
 * as câmeras aparecerem, e tudo o que o Foundry desenha (tokens, desenhos,
 * textos, réguas, iluminação) continua por cima, normalmente.
 */

const textureCache = new Map();

async function loadTex(src) {
  if (!src) return null;
  if (textureCache.has(src)) return textureCache.get(src);
  const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  let tex = null;
  try { tex = await fn(src); } catch (e) { tex = null; }
  textureCache.set(src, tex);
  return tex;
}

function sceneRect() {
  const d = canvas?.dimensions;
  return d?.sceneRect ?? new PIXI.Rectangle(d?.sceneX ?? 0, d?.sceneY ?? 0, d?.sceneWidth ?? 0, d?.sceneHeight ?? 0);
}

/** Ajusta um sprite para cobrir w×h (cortando o excesso), opcionalmente espelhado. */
function coverSprite(sprite, w, h, mirror) {
  const tw = sprite.texture?.width || 0, th = sprite.texture?.height || 0;
  if (!tw || !th) { sprite.visible = false; return false; }
  const s = Math.max(w / tw, h / th);
  sprite.scale.set(mirror ? -s : s, s);
  return true;
}

const Overlay = {
  layer: null,
  front: null,
  videos: null,
  slotEls: new Map(),
  timer: null,
  root: null,

  build() {
    this.destroy();
    const on = isActive();
    document.body.classList.toggle("mdc-active", on);
    document.body.classList.toggle("mdc-hide-dock", on && game.settings.get(MOD, "esconderDock"));
    if (!on) return;
    const primary = canvas?.primary;
    if (!primary) return;

    const cfg = sceneCfg();

    // Camada PIXI com as câmeras
    // Usa o contêiner próprio do grupo primário do Foundry quando existir
    const PCC = foundry.canvas?.primary?.PrimaryCanvasContainer ?? globalThis.PrimaryCanvasContainer;
    let layer;
    try { layer = PCC ? new PCC() : new PIXI.Container(); } catch (e) { layer = new PIXI.Container(); }
    layer.name = "mesa-de-cameras";
    layer.eventMode = "none";
    this.layer = layer;

    // Vídeos ficam num cantinho invisível do DOM; o canvas desenha a partir deles
    const videos = document.createElement("div");
    videos.id = "mdc-videos";
    document.body.appendChild(videos);
    this.videos = videos;

    // Botões de câmera/microfone por cima do canvas
    const front = document.createElement("div");
    front.id = "mdc-front";
    const board = document.getElementById("board");
    if (board) board.insertAdjacentElement("afterend", front);
    else document.body.appendChild(front);
    this.front = front;
    this.root = front;

    for (const slot of cfg.slots) {
      const video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      videos.appendChild(video);

      const box = new PIXI.Container();
      const backdrop = new PIXI.Graphics();
      const mask = new PIXI.Graphics();
      const vSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      const fSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      vSprite.anchor.set(0.5); fSprite.anchor.set(0.5);
      vSprite.visible = fSprite.visible = false;
      const content = new PIXI.Container();
      content.addChild(backdrop, fSprite, vSprite);
      content.mask = mask;
      box.addChild(content, mask);
      layer.addChild(box);

      const ctrl = document.createElement("div");
      ctrl.className = "mdc-controls";
      ctrl.innerHTML = `
        <button type="button" data-act="cam" title="Ligar/desligar minha câmera"><i class="fas fa-video"></i></button>
        <button type="button" data-act="mic" title="Ligar/desligar meu microfone"><i class="fas fa-microphone"></i></button>
        <button type="button" data-act="img" title="Imagem com a câmera desligada"><i class="fas fa-image"></i></button>`;
      ctrl.addEventListener("click", ev => {
        const act = ev.target.closest("button")?.dataset.act;
        if (act === "cam") toggleMyCamera();
        if (act === "mic") toggleMyMic();
        if (act === "img") openMyImageDialog();
      });
      front.appendChild(ctrl);

      this.slotEls.set(slot.id, {
        slot, video, box, backdrop, mask, vSprite, fSprite, ctrl,
        el: { classList: { contains: () => false } }, // compatibilidade com liveKitObserve
        w: 0, h: 0, showing: false, vTex: null, fbSrc: null
      });
    }

    this.attachLayer();
    this.layout();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  },

  /** Põe a camada dentro do grupo primário, logo abaixo do fundo da cena. */
  attachLayer() {
    const p = canvas.primary;
    const bg = p.background;
    const layer = this.layer;
    layer.elevation = (bg?.elevation ?? 0) - 1;
    layer.sortLayer = -1;
    layer.sort = -1e9;
    layer.zIndex = -1e9;
    p.addChild(layer);
    if (!p._mdcSortPatched) {
      const orig = p.sortChildren;
      p.sortChildren = function(...args) {
        const r = orig.apply(this, args);
        Overlay.fixOrder();
        return r;
      };
      p._mdcSortPatched = true;
    }
    p.sortDirty = true;
    this.fixOrder();
  },

  /** Garante que a camada fique antes (abaixo) do fundo da cena. */
  fixOrder() {
    const p = canvas?.primary, layer = this.layer;
    if (!p || !layer || layer.destroyed || layer.parent !== p) return;
    const bg = p.background;
    const iB = bg ? p.children.indexOf(bg) : -1;
    const iL = p.children.indexOf(layer);
    if (iB < 0) { if (iL !== 0) { p.children.splice(iL, 1); p.children.unshift(layer); } return; }
    if (iL > iB) {
      p.children.splice(iL, 1);
      p.children.splice(iB, 0, layer);
    }
  },

  layout() {
    if (!this.layer) return;
    const r = sceneRect();
    for (const d of this.slotEls.values()) {
      const { slot, box, mask, backdrop } = d;
      const w = slot.w * r.width, h = slot.h * r.height;
      box.position.set(r.x + (slot.x + slot.w / 2) * r.width, r.y + (slot.y + slot.h / 2) * r.height);
      box.rotation = (slot.rot || 0) * Math.PI / 180;
      mask.clear().beginFill(0xffffff).drawRect(-w / 2, -h / 2, w, h).endFill();
      backdrop.clear().beginFill(0x111111).drawRect(-w / 2, -h / 2, w, h).endFill();
      d.w = w; d.h = h;
      try { d.lkInfo?.handleResize?.(); } catch (e) { /* ignora */ }
    }
    this.placeControls();
  },

  /** Posiciona os botões na tela, na parte de baixo de cada foto. */
  placeControls() {
    const t = canvas?.stage?.worldTransform;
    if (!t) return;
    for (const d of this.slotEls.values()) {
      const a = d.box.rotation, c = Math.cos(a), s = Math.sin(a);
      const ly = d.h / 2 - 8;
      const wx = d.box.x - s * ly, wy = d.box.y + c * ly;
      const p = t.apply(new PIXI.Point(wx, wy));
      d.ctrl.style.left = `${p.x}px`;
      d.ctrl.style.top = `${p.y}px`;
    }
  },

  refresh() {
    if (!this.layer) return;
    if (this.layer.destroyed) return this.build();
    if (this.layer.parent !== canvas.primary) this.attachLayer();
    this.fixOrder();

    for (const d of this.slotEls.values()) {
      const { slot, video, ctrl, vSprite, fSprite, backdrop } = d;
      const user = slot.user ? game.users.get(slot.user) : null;
      if (!user) {
        liveKitUnobserve(d);
        ctrl.classList.remove("mdc-mine");
        if (video.srcObject) video.srcObject = null;
        vSprite.visible = fSprite.visible = backdrop.visible = false;
        d.showing = false;
        continue;
      }
      backdrop.visible = true;
      const mine = user.id === game.user.id;
      ctrl.classList.toggle("mdc-mine", mine);

      if (mine && cameraOffByFlag(user)) {
        streamFor(user.id)?.getVideoTracks?.().forEach(t => { if (t.enabled) t.enabled = false; });
      }

      const track = videoTrackFor(user.id);
      const now = Date.now();
      let show = videoVisible(user, track);
      if (show) video._offSince = 0;
      else if (!cameraOffByFlag(user) && user.active && video.srcObject) {
        video._offSince ||= now;
        if (now - video._offSince < 2000) show = true;
      }

      if (show && track) {
        const cur = video.srcObject;
        const ok = cur instanceof MediaStream && cur.getVideoTracks().some(t => t === track);
        if (!ok) {
          video.srcObject = new MediaStream([track]);
          video._assignedAt = now;
          this.resetVideoTexture(d);
        }
        if (video.paused) video.play?.().catch(() => {});

        // Vídeo parado (sem quadros novos): pede o vídeo de novo ao LiveKit e reconecta
        const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        const progress = `${frames}|${video.currentTime}`;
        if (progress !== video._progress) { video._progress = progress; video._lastProgress = now; }
        const stalledFor = now - Math.max(video._lastProgress || 0, video._assignedAt || 0);
        if (stalledFor > 5000 && now - (video._lastKick || 0) > 8000) {
          video._lastKick = now;
          try { d.lkTrack?.updateVisibility?.(true); } catch (e) { /* ignora */ }
          video.srcObject = new MediaStream([track]);
          video._assignedAt = now;
          this.resetVideoTexture(d);
          video.play?.().catch(() => {});
        }
      } else if (!show && video.srcObject && !(video._offSince && now - video._offSince < 2000)) {
        video.srcObject = null;
        this.resetVideoTexture(d);
      }

      // Textura do vídeo: cria quando o vídeo já tem tamanho
      if (video.srcObject && !d.vTex && video.videoWidth > 0) {
        try {
          d.vTex = PIXI.Texture.from(video, { resourceOptions: { autoPlay: true } });
          vSprite.texture = d.vTex;
        } catch (e) { console.warn(`${MOD} | textura de vídeo`, e); }
      }
      const videoOn = show && !!video.srcObject && !!d.vTex;
      vSprite.visible = videoOn && coverSprite(vSprite, d.w, d.h, mine);

      // Imagem do personagem quando a câmera está desligada
      const src = fallbackImage(user, slot);
      if (d.fbSrc !== src) {
        d.fbSrc = src;
        loadTex(src).then(tex => {
          if (d.fbSrc !== src || fSprite.destroyed) return;
          fSprite.texture = tex ?? PIXI.Texture.EMPTY;
          coverSprite(fSprite, d.w, d.h, false);
        });
      }
      fSprite.visible = !vSprite.visible && coverSprite(fSprite, d.w, d.h, false);

      d.showing = vSprite.visible;
      d.wanted = !!user.active && !cameraOffByFlag(user) && !rtcUser(user.id)?.hidden;
      if (!mine) liveKitObserve(d, user.id);
      const vis = !!d.lkInfo?.visible;
      if (d.lkInfo && d.lkVisible !== vis) {
        d.lkVisible = vis;
        d.lkInfo.visibilityChangedAt = now;
        try { d.lkInfo.handleVisibilityChanged?.(); } catch (e) { /* ignora */ }
      }

      if (mine) {
        const camOff = cameraOffByFlag(user), micOff = isMyMicMuted();
        const cam = ctrl.querySelector('[data-act="cam"]'), mic = ctrl.querySelector('[data-act="mic"]');
        cam?.classList.toggle("mdc-off", camOff);
        mic?.classList.toggle("mdc-off", micOff);
        const ci = cam?.querySelector("i"); if (ci) ci.className = camOff ? "fas fa-video-slash" : "fas fa-video";
        const mi = mic?.querySelector("i"); if (mi) mi.className = micOff ? "fas fa-microphone-slash" : "fas fa-microphone";
      }
    }
    this.placeControls();
  },

  /** Mostra os botões só quando o mouse está sobre a própria foto. */
  onPointerMove(ev) {
    if (!this.layer) return;
    const t = canvas?.stage?.worldTransform;
    if (!t) return;
    const w = t.applyInverse(new PIXI.Point(ev.clientX, ev.clientY));
    for (const d of this.slotEls.values()) {
      if (!d.ctrl.classList.contains("mdc-mine")) { d.ctrl.classList.remove("mdc-hover"); continue; }
      const a = -d.box.rotation, c = Math.cos(a), s = Math.sin(a);
      const dx = w.x - d.box.x, dy = w.y - d.box.y;
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      const inside = Math.abs(lx) <= d.w / 2 && Math.abs(ly) <= d.h / 2;
      d.ctrl.classList.toggle("mdc-hover", inside || d.ctrl.matches(":hover"));
    }
  },

  resetVideoTexture(d) {
    if (d.vTex) {
      d.vSprite.texture = PIXI.Texture.EMPTY;
      try { d.vTex.destroy(true); } catch (e) { /* ignora */ }
      d.vTex = null;
    }
  },

  destroy() {
    clearInterval(this.timer); this.timer = null;
    for (const d of this.slotEls.values()) {
      liveKitUnobserve(d);
      d.video.srcObject = null;
      this.resetVideoTexture(d);
    }
    this.slotEls.clear();
    if (this.layer && !this.layer.destroyed) {
      this.layer.parent?.removeChild(this.layer);
      this.layer.destroy({ children: true });
    }
    this.layer = null;
    this.front?.remove(); this.front = this.root = null;
    this.videos?.remove(); this.videos = null;
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
    const scene = canvas?.scene;
    if (!scene) return ui.notifications.warn("Abra uma cena primeiro.");
    const image = sceneImage(scene);
    if (!image) return ui.notifications.warn("Mesa de Câmeras: coloque a arte (PNG com áreas transparentes) como imagem de fundo desta cena.");
    this.scene = scene;
    this.cfg = { ...sceneCfg(scene), image };
    const el = document.createElement("div");
    el.id = "mdc-editor";
    el.innerHTML = `
      <div class="mdc-ed-window">
        <header>
          <h2><i class="fas fa-photo-film"></i> Mesa de Câmeras</h2>
          <button type="button" class="mdc-ed-close" title="Fechar"><i class="fas fa-times"></i></button>
        </header>
        <div class="mdc-ed-toolbar">
          <div class="mdc-ed-info">
            <strong class="mdc-ed-scene"></strong>
            <span class="mdc-ed-path"></span>
          </div>
          <div class="mdc-ed-actions">
            <button type="button" data-act="detect"><i class="fas fa-wand-magic-sparkles"></i> Detectar áreas</button>
            <button type="button" data-act="add"><i class="fas fa-plus"></i> Adicionar área</button>
          </div>
        </div>
        <div class="mdc-ed-canvas"><div class="mdc-ed-stage"></div></div>
        <p class="mdc-ed-hint">Arraste a área para mover. Quadrado amarelo (canto inferior direito): redimensionar. Bolinha no topo: girar (Shift = graus inteiros). Você também pode digitar o ângulo.</p>
        <footer>
          <label class="mdc-ed-check"><input type="checkbox" name="ativa"> Mesa ativa nesta cena</label>
          <span class="mdc-ed-spacer"></span>
          <button type="button" data-act="cancel">Cancelar</button>
          <button type="button" data-act="save" class="mdc-primary"><i class="fas fa-save"></i> Salvar</button>
        </footer>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    el.querySelector(".mdc-ed-scene").textContent = `Cena: ${scene.name}`;
    el.querySelector(".mdc-ed-path").textContent = `Fundo: ${image}`;
    el.querySelector('[name="ativa"]').checked = this.cfg.ativa;
    el.querySelector(".mdc-ed-close").addEventListener("click", () => this.close());
    el.addEventListener("click", ev => {
      const act = ev.target.closest("button[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "detect") this.detect();
      else if (act === "add") this.addSlot();
      else if (act === "cancel") this.close();
      else if (act === "save") this.save();
    });

    this._onResize = () => this.renderStage();
    window.addEventListener("resize", this._onResize);
    this.renderStage();
    if (!this.cfg.slots.length) this.detect(true);
  },

  close() {
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    this.el?.remove();
    this.el = null;
  },

  async detect(quiet = false) {
    if (!this.cfg.image) return ui.notifications.warn("A cena não tem imagem de fundo.");
    try {
      const found = await detectSlots(this.cfg.image);
      // Reaproveita os jogadores já escolhidos, pela ordem
      const prevUsers = this.cfg.slots.map(s => s.user);
      const prevImgs = this.cfg.slots.map(s => s.img);
      found.forEach((s, i) => { s.user = prevUsers[i] ?? null; if (prevImgs[i]) s.img = prevImgs[i]; });
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
    this.cfg.slots.push({ id: foundry.utils.randomID(), x: 0.4, y: 0.4, w: 0.2, h: 0.2, rot: 0, user: null });
    this.renderStage();
  },

  renderStage() {
    if (!this.el) return;
    const wrap = this.el.querySelector(".mdc-ed-canvas");
    const stage = this.el.querySelector(".mdc-ed-stage");
    stage.innerHTML = "";
    if (!this.cfg.image) {
      stage.style.width = "100%"; stage.style.height = "100%";
      stage.innerHTML = `<div class="mdc-ed-empty">Coloque a arte como fundo da cena.</div>`;
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
        <div class="mdc-ed-fields">
          <select class="mdc-ed-user">${userOptions}</select>
          <label class="mdc-ed-rot" title="Giro em graus">
            <i class="fas fa-rotate"></i>
            <input type="number" step="0.5" min="-180" max="180" value="${slot.rot || 0}">°
          </label>
          <span class="mdc-ed-imgrow">
            <button type="button" class="mdc-ed-imgbtn" title="Imagem com a câmera desligada"><i class="fas fa-image"></i> ${slot.img ? "Trocar" : "Imagem"}</button>
            ${slot.img ? `<button type="button" class="mdc-ed-imgclr" title="Tirar imagem"><i class="fas fa-xmark"></i></button>` : ""}
          </span>
        </div>
        <span class="mdc-ed-rothandle" title="Arraste para girar"></span>
        <span class="mdc-ed-handle"></span>`;
      const sel = box.querySelector("select");
      sel.value = slot.user ?? "";
      sel.addEventListener("change", () => { slot.user = sel.value || null; });
      const rotInput = box.querySelector(".mdc-ed-rot input");
      rotInput.addEventListener("input", () => {
        slot.rot = Number(rotInput.value) || 0;
        this.placeBox(box, slot);
      });
      for (const el of [sel, rotInput]) {
        el.addEventListener("pointerdown", ev => ev.stopPropagation());
        el.addEventListener("keydown", ev => ev.stopPropagation());
      }
      if (slot.img) {
        const thumb = document.createElement("img");
        thumb.className = "mdc-ed-thumb";
        thumb.src = slot.img;
        box.prepend(thumb);
      }
      for (const b of box.querySelectorAll(".mdc-ed-imgbtn, .mdc-ed-imgclr")) {
        b.addEventListener("pointerdown", ev => ev.stopPropagation());
      }
      box.querySelector(".mdc-ed-imgbtn").addEventListener("click", async () => {
        const path = await pickFile(slot.img, this.el);
        if (path) { slot.img = path; this.renderStage(); }
      });
      box.querySelector(".mdc-ed-imgclr")?.addEventListener("click", () => {
        delete slot.img;
        this.renderStage();
      });
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
      width: `${slot.w * 100}%`, height: `${slot.h * 100}%`,
      transform: `rotate(${slot.rot || 0}deg)`
    });
    const inp = box.querySelector(".mdc-ed-rot input");
    if (inp && document.activeElement !== inp) inp.value = slot.rot || 0;
  },

  startDrag(ev, box, slot, stage) {
    ev.preventDefault();
    const resize = ev.target.classList.contains("mdc-ed-handle");
    const rotate = ev.target.classList.contains("mdc-ed-rothandle");
    const rect = stage.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY;
    const o = { ...slot };
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const cx = rect.left + (slot.x + slot.w / 2) * rect.width;
    const cy = rect.top + (slot.y + slot.h / 2) * rect.height;
    const a0 = Math.atan2(sy - cy, sx - cx);
    const move = e => {
      const dx = (e.clientX - sx) / rect.width, dy = (e.clientY - sy) / rect.height;
      if (rotate) {
        const a = Math.atan2(e.clientY - cy, e.clientX - cx);
        let deg = (o.rot || 0) + (a - a0) * 180 / Math.PI;
        if (e.shiftKey) deg = Math.round(deg);
        slot.rot = Math.round(deg * 10) / 10;
      } else if (resize) {
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
    const ativa = this.el.querySelector('[name="ativa"]').checked;
    await setSceneCfg(this.scene, { ativa, slots: this.cfg.slots });
    ui.notifications.info(`Mesa de Câmeras salva na cena "${this.scene.name}".`);
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

  game.settings.register(MOD, "esconderDock", {
    name: "Esconder o dock de câmeras padrão",
    hint: "Enquanto a mesa estiver ativa, o dock normal do Foundry fica invisível. O áudio continua funcionando.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: rebuild
  });
  game.settings.register(MOD, "ocultarParaMim", {
    name: "Ocultar a mesa só para mim",
    hint: "Esconde as câmeras da mesa apenas neste computador.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: rebuild
  });

  game.settings.registerMenu(MOD, "editor", {
    name: "Configurar mesa da cena atual",
    label: "Abrir editor",
    hint: "Detectar as áreas transparentes do fundo da cena e definir quem fica em cada uma.",
    icon: "fas fa-photo-film",
    type: makeMenuClass(),
    restricted: true
  });

  game.keybindings.register(MOD, "toggle", {
    name: "Ligar/desligar a mesa na cena atual (GM)",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { toggleSceneMesa(); return true; }
  });
});

Hooks.once("ready", () => {
  // Se o jogador tinha deixado a câmera desligada, mantém desligada
  if (cameraOffByFlag(game.user)) setTimeout(() => setLocalVideoTrack(false), 2000);

  game.modules.get(MOD).api = {
    openEditor: () => Editor.open(),
    toggle: on => toggleSceneMesa(on),
    toggleMyCamera,
    toggleMyMic,
    detectSlots
  };
});

Hooks.on("canvasReady", () => Overlay.build());
Hooks.on("canvasTearDown", () => Overlay.destroy());
Hooks.on("canvasPan", () => Overlay.placeControls());
window.addEventListener("resize", () => Overlay.placeControls());
window.addEventListener("pointermove", ev => Overlay.onPointerMove(ev), { passive: true });

Hooks.on("updateScene", (scene, changes) => {
  if (scene.id !== canvas?.scene?.id) return;
  if (foundry.utils.hasProperty(changes, `flags.${MOD}`) || foundry.utils.hasProperty(changes, `flags.-=${MOD}`)) {
    Overlay.build();
    ui.controls?.render?.();
  }
});
// Fundo da cena trocado: o Foundry redesenha o canvas e o canvasReady reconstrói a mesa.

Hooks.on("updateUser", (user, changes) => {
  if (changes.flags?.[MOD] || "character" in changes || "avatar" in changes || "active" in changes) Overlay.refresh();
});
Hooks.on("rtcSettingsChanged", () => Overlay.refresh());
Hooks.on("renderCameraViews", () => Overlay.refresh());

// Botões nos controles da cena (GM): v12 usa array, v13 usa objeto
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const active = sceneCfg().ativa;
  if (Array.isArray(controls)) {
    const token = controls.find(c => c.name === "token");
    if (!token) return;
    token.tools.push(
      { name: "mdc-toggle", title: "Mesa de Câmeras: ligar/desligar nesta cena", icon: "fas fa-photo-film",
        toggle: true, active, onClick: on => toggleSceneMesa(on) },
      { name: "mdc-editor", title: "Mesa de Câmeras: configurar esta cena", icon: "fas fa-sliders",
        button: true, onClick: () => Editor.open() }
    );
  } else {
    const token = controls.tokens ?? controls.token;
    if (!token?.tools) return;
    const n = Object.keys(token.tools).length;
    token.tools["mdc-toggle"] = {
      name: "mdc-toggle", title: "Mesa de Câmeras: ligar/desligar nesta cena", icon: "fas fa-photo-film",
      order: n + 1, toggle: true, active,
      onChange: (event, on) => toggleSceneMesa(on)
    };
    token.tools["mdc-editor"] = {
      name: "mdc-editor", title: "Mesa de Câmeras: configurar esta cena", icon: "fas fa-sliders",
      order: n + 2, button: true,
      onChange: () => Editor.open()
    };
  }
});
