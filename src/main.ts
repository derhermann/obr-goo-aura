import OBR, {
  buildEffect,
  isImage,
  type Effect,
  type Matrix,
  type Uniform,
} from "@owlbear-rodeo/sdk";

const EXTENSION_ID = "com.custom.goo-aura";
const META_KEY = `${EXTENSION_ID}/enabled`;
const COLOR_META_KEY = `${EXTENSION_ID}/color`;
const EFFECT_META_KEY = `${EXTENSION_ID}/is-goo-effect`;
const CONTEXT_MENU_ID = `${EXTENSION_ID}/toggle`;

const CUSTOM_COLORS_STORAGE_KEY = `${EXTENSION_ID}/custom-colors`;
const DEFAULT_COLOR_STORAGE_KEY = `${EXTENSION_ID}/default-hex`;

const NUM_MATRICES = 14; // 14 matrices × 3 monsters per matrix = 42 monsters max
const MAX_TOKENS = NUM_MATRICES * 3;
const MAX_ACTIVE_PALETTE = 12; // 4 palette matrices × 3 RGB colors = 12 simultaneous colors

// Tweak these to adjust aura size and transparency
const AURA_RADIUS_MULTIPLIER = 1.25; // Radius in grid squares
const SMOOTHNESS_MULTIPLIER = 0.7;   // How far apart blobs stretch to merge
const GOO_OPACITY = 0.42;            // Transparency (0.0 to 1.0)

interface SavedGooColor {
  id: string;
  name: string;
  hex: string;
  builtIn?: boolean;
}

const STARTING_COLORS: SavedGooColor[] = [
  { id: "builtin-acid",    name: "Acid Green",    hex: "#2ed959", builtIn: true },
  { id: "builtin-crimson", name: "Crimson Blood", hex: "#ef4444", builtIn: true },
  { id: "builtin-arcane",  name: "Arcane Purple", hex: "#a855f7", builtIn: true },
];

const matrixUniforms = Array.from(
  { length: NUM_MATRICES },
  (_, m) => `uniform float3x3 uM${m};`
).join("\n");

// Each row of a 3x3 matrix stores one monster: [x, y, paletteIndex]
const slotDefs: { pos: string; col: string }[] = [];
for (let m = 0; m < NUM_MATRICES; m++) {
  for (let r = 0; r < 3; r++) {
    slotDefs.push({
      pos: `float2(uM${m}[${r}][0], uM${m}[${r}][1])`,
      col: `uM${m}[${r}][2]`,
    });
  }
}

const mergeSteps = slotDefs
  .slice(1)
  .map(
    (slot, i) => `
    if (uCount > ${i + 1.5}) {
        float di = length(coord - ${slot.pos}) - uRadius;
        half3 ci = getPaletteColor(${slot.col});
        float h = clamp(0.5 + 0.5 * (di - d) / uSmoothness, 0.0, 1.0);
        d = mix(di, d, h) - uSmoothness * h * (1.0 - h);
        col = mix(ci, col, half(h));
    }`
  )
  .join("\n");

const GOO_SKSL = `
${matrixUniforms}

uniform float3x3 uPal0;
uniform float3x3 uPal1;
uniform float3x3 uPal2;
uniform float3x3 uPal3;

uniform float uCount;
uniform float uRadius;
uniform float uSmoothness;
uniform float uOpacity;

half3 getPaletteColor(float idx) {
    if (idx < 0.5)  return half3(uPal0[0][0], uPal0[0][1], uPal0[0][2]);
    if (idx < 1.5)  return half3(uPal0[1][0], uPal0[1][1], uPal0[1][2]);
    if (idx < 2.5)  return half3(uPal0[2][0], uPal0[2][1], uPal0[2][2]);
    if (idx < 3.5)  return half3(uPal1[0][0], uPal1[0][1], uPal1[0][2]);
    if (idx < 4.5)  return half3(uPal1[1][0], uPal1[1][1], uPal1[1][2]);
    if (idx < 5.5)  return half3(uPal1[2][0], uPal1[2][1], uPal1[2][2]);
    if (idx < 6.5)  return half3(uPal2[0][0], uPal2[0][1], uPal2[0][2]);
    if (idx < 7.5)  return half3(uPal2[1][0], uPal2[1][1], uPal2[1][2]);
    if (idx < 8.5)  return half3(uPal2[2][0], uPal2[2][1], uPal2[2][2]);
    if (idx < 9.5)  return half3(uPal3[0][0], uPal3[0][1], uPal3[0][2]);
    if (idx < 10.5) return half3(uPal3[1][0], uPal3[1][1], uPal3[1][2]);
    return half3(uPal3[2][0], uPal3[2][1], uPal3[2][2]);
}

half4 main(float2 coord) {
    if (uCount < 0.5) {
        return half4(0.0);
    }

    float d = length(coord - ${slotDefs[0].pos}) - uRadius;
    half3 col = getPaletteColor(${slotDefs[0].col});
${mergeSteps}

    // Crisp anti-aliased liquid edge
    float mask = 1.0 - smoothstep(-1.5, 1.5, d);
    float alpha = mask * uOpacity;

    // Skia requires premultiplied alpha
    return half4(col * alpha, alpha);
}
`;

function normalizeHex(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const expanded = trimmed
      .split("")
      .map((c) => c + c)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = normalizeHex(hex) ?? STARTING_COLORS[0].hex;
  const num = parseInt(clean.slice(1), 16);
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255,
  ];
}

function getSavedColors(): SavedGooColor[] {
  try {
    const raw = localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY);
    if (!raw) return [...STARTING_COLORS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...STARTING_COLORS];
    const custom = parsed.filter(
      (c): c is SavedGooColor =>
        c &&
        typeof c.id === "string" &&
        typeof c.name === "string" &&
        typeof c.hex === "string" &&
        normalizeHex(c.hex) !== null
    );
    return [...STARTING_COLORS, ...custom];
  } catch {
    return [...STARTING_COLORS];
  }
}

function saveCustomColors(customColors: SavedGooColor[]) {
  localStorage.setItem(
    CUSTOM_COLORS_STORAGE_KEY,
    JSON.stringify(customColors.filter((c) => !c.builtIn))
  );
}

function getDefaultHex(): string {
  const saved = localStorage.getItem(DEFAULT_COLOR_STORAGE_KEY);
  return (saved && normalizeHex(saved)) || STARTING_COLORS[0].hex;
}

function setDefaultHex(hex: string) {
  const norm = normalizeHex(hex);
  if (norm) {
    localStorage.setItem(DEFAULT_COLOR_STORAGE_KEY, norm);
  }
}

let isSyncing = false;
let syncQueued = false;

// Runs for both GMs and Players so everyone sees the rendered goo
async function syncGooEffect() {
  if (isSyncing) {
    syncQueued = true;
    return;
  }
  isSyncing = true;

  try {
    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) return;

    const [items, localItems, dpi] = await Promise.all([
      OBR.scene.items.getItems(),
      OBR.scene.local.getItems(),
      OBR.scene.grid.getDpi(),
    ]);

    const radius = dpi * AURA_RADIUS_MULTIPLIER;
    const smoothness = dpi * SMOOTHNESS_MULTIPLIER;
    const padding = radius + smoothness * 1.5;

    // Collect positions & hex colors of up to 42 tokens
    const activeHexes: string[] = [];
    const tokens: { x: number; y: number; colorIdx: number }[] = [];

    for (const item of items) {
      if (isImage(item) && item.metadata[META_KEY]) {
        const rawColor = item.metadata[COLOR_META_KEY];
        const hex =
          typeof rawColor === "string"
            ? normalizeHex(rawColor) ?? STARTING_COLORS[0].hex
            : STARTING_COLORS[0].hex;

        let colorIdx = activeHexes.indexOf(hex);
        if (colorIdx === -1) {
          if (activeHexes.length < MAX_ACTIVE_PALETTE) {
            colorIdx = activeHexes.length;
            activeHexes.push(hex);
          } else {
            colorIdx = activeHexes.length - 1;
          }
        }

        tokens.push({ x: item.position.x, y: item.position.y, colorIdx });
        if (tokens.length >= MAX_TOKENS) break;
      }
    }

    const existingEffect = localItems.find(
      (item) => item.metadata[EFFECT_META_KEY]
    );

    if (tokens.length === 0) {
      if (existingEffect) {
        await OBR.scene.local.deleteItems([existingEffect.id]);
      }
      return;
    }

    // Calculate bounding box around all active goo tokens
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const t of tokens) {
      if (t.x < minX) minX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.x > maxX) maxX = t.x;
      if (t.y > maxY) maxY = t.y;
    }

    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);

    // Pack up to 12 active hex colors into 4 float3x3 palette matrices
    const paletteMatrices: Matrix[] = [];
    for (let p = 0; p < 4; p++) {
      const c0 = hexToRgb(activeHexes[p * 3 + 0] ?? STARTING_COLORS[0].hex);
      const c1 = hexToRgb(activeHexes[p * 3 + 1] ?? STARTING_COLORS[0].hex);
      const c2 = hexToRgb(activeHexes[p * 3 + 2] ?? STARTING_COLORS[0].hex);
      paletteMatrices.push([...c0, ...c1, ...c2] as Matrix);
    }

    const uniforms: Uniform[] = [
      { name: "uPal0", value: paletteMatrices[0] },
      { name: "uPal1", value: paletteMatrices[1] },
      { name: "uPal2", value: paletteMatrices[2] },
      { name: "uPal3", value: paletteMatrices[3] },
      { name: "uCount", value: tokens.length },
      { name: "uRadius", value: radius },
      { name: "uSmoothness", value: smoothness },
      { name: "uOpacity", value: GOO_OPACITY },
    ];

    // Pack 3 monsters per 9-element Matrix: [x, y, paletteIndex]
    for (let m = 0; m < NUM_MATRICES; m++) {
      const t0 = tokens[m * 3 + 0];
      const t1 = tokens[m * 3 + 1];
      const t2 = tokens[m * 3 + 2];

      const mat: Matrix = [
        t0 ? t0.x - minX : 0, t0 ? t0.y - minY : 0, t0 ? t0.colorIdx : 0,
        t1 ? t1.x - minX : 0, t1 ? t1.y - minY : 0, t1 ? t1.colorIdx : 0,
        t2 ? t2.x - minX : 0, t2 ? t2.y - minY : 0, t2 ? t2.colorIdx : 0,
      ];

      uniforms.push({ name: `uM${m}`, value: mat });
    }

    if (!existingEffect) {
      const effect = buildEffect()
        .name("Goo Aura")
        .effectType("STANDALONE")
        .layer("DRAWING")
        .locked(true)
        .disableHit(true)
        .position({ x: minX, y: minY })
        .width(width)
        .height(height)
        .sksl(GOO_SKSL)
        .uniforms(uniforms)
        .metadata({ [EFFECT_META_KEY]: true })
        .build();

      await OBR.scene.local.addItems([effect]);
    } else {
      await OBR.scene.local.updateItems<Effect>(
        [existingEffect.id],
        (draft) => {
          const effect = draft[0];
          if (!effect) return;
          effect.position = { x: minX, y: minY };
          effect.width = width;
          effect.height = height;
          effect.sksl = GOO_SKSL;
          effect.uniforms = uniforms;
        }
      );
    }
  } finally {
    isSyncing = false;
    if (syncQueued) {
      syncQueued = false;
      syncGooEffect();
    }
  }
}

let contextMenuRegistered = false;

async function syncContextMenuForRole(role: "GM" | "PLAYER") {
  if (role === "GM" && !contextMenuRegistered) {
    contextMenuRegistered = true;
    await OBR.contextMenu.create({
      id: CONTEXT_MENU_ID,
      icons: [
        {
          icon: "/icon.svg",
          label: "Enable Goo Aura",
          filter: {
            every: [
              { key: "layer", value: "CHARACTER" },
              { key: ["metadata", META_KEY], value: undefined },
            ],
          },
        },
        {
          icon: "/icon.svg",
          label: "Disable Goo Aura",
          filter: {
            every: [{ key: "layer", value: "CHARACTER" }],
          },
        },
      ],
      async onClick(context) {
        if ((await OBR.player.getRole()) !== "GM") return;

        const shouldEnable = context.items.some(
          (item) => !item.metadata[META_KEY]
        );
        const defaultHex = getDefaultHex();
        await OBR.scene.items.updateItems(context.items, (items) => {
          for (const item of items) {
            if (shouldEnable) {
              item.metadata[META_KEY] = true;
              if (typeof item.metadata[COLOR_META_KEY] !== "string") {
                item.metadata[COLOR_META_KEY] = defaultHex;
              }
            } else {
              delete item.metadata[META_KEY];
              delete item.metadata[COLOR_META_KEY];
            }
          }
        });
      },
    });
  } else if (role !== "GM" && contextMenuRegistered) {
    contextMenuRegistered = false;
    await OBR.contextMenu.remove(CONTEXT_MENU_ID);
  }
}

async function renderPopoverUI() {
  const style = document.createElement("style");
  style.textContent = `
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #1e1f24;
      color: #f3f4f6;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      user-select: none;
    }
    .goo-color-list {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }
    .goo-color-list::-webkit-scrollbar {
      width: 5px;
      height: 0px;
    }
    .goo-color-list::-webkit-scrollbar-track {
      background: transparent;
    }
    .goo-color-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 999px;
    }
    .goo-color-list::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
    }
  `;
  document.head.appendChild(style);

  let currentRole = await OBR.player.getRole();

  function renderLockedPlayerView() {
    const wrapper = document.createElement("div");
    wrapper.style.padding = "20px 16px";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.textAlign = "center";
    wrapper.style.height = "100vh";
    wrapper.style.gap = "8px";

    const heading = document.createElement("div");
    heading.style.fontSize = "13px";
    heading.style.fontWeight = "600";
    heading.style.color = "#f3f4f6";
    heading.textContent = "GM Only";

    const desc = document.createElement("div");
    desc.style.fontSize = "11px";
    desc.style.lineHeight = "1.45";
    desc.style.color = "#9ca3af";
    desc.textContent =
      "Only the Game Master can add, remove, or change Goo Auras.";

    wrapper.append(heading, desc);
    document.body.replaceChildren(wrapper);
  }

  function renderGmEditorView() {
    const container = document.createElement("div");
    container.style.padding = "12px";
    container.style.display = "flex";
    container.style.flexDirection = "column";

    let activeHex = getDefaultHex();

    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.marginBottom = "8px";

    const title = document.createElement("span");
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    title.textContent = "Goo Aura";

    const statusBadge = document.createElement("span");
    statusBadge.style.fontSize = "11px";
    statusBadge.style.color = "#9ca3af";
    statusBadge.textContent = "No selection";

    headerRow.append(title, statusBadge);

    // Vertical single-column list of color rows
    const colorList = document.createElement("div");
    colorList.className = "goo-color-list";
    colorList.style.display = "flex";
    colorList.style.flexDirection = "column";
    colorList.style.gap = "6px";
    colorList.style.maxHeight = "114px";
    colorList.style.overflowY = "auto";
    colorList.style.overflowX = "hidden";
    colorList.style.padding = "2px";
    colorList.style.marginBottom = "10px";

    async function applyColorToSelection(hex: string) {
      if ((await OBR.player.getRole()) !== "GM") return;

      const selection = await OBR.player.getSelection();
      if (!selection || selection.length === 0) return;

      await OBR.scene.items.updateItems(selection, (items) => {
        for (const item of items) {
          if (isImage(item) && item.layer === "CHARACTER") {
            item.metadata[META_KEY] = true;
            item.metadata[COLOR_META_KEY] = hex;
          }
        }
      });
    }

    function rebuildSwatches() {
      const colors = getSavedColors();
      colorList.replaceChildren();

      colors.forEach((preset) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        row.style.width = "100%";
        row.style.flexShrink = "0";

        const btn = document.createElement("button");
        btn.title = `${preset.name} (${preset.hex})`;
        btn.style.flex = "1";
        btn.style.minWidth = "0";
        btn.style.height = "30px";
        btn.style.borderRadius = "6px";
        btn.style.border = "none";
        btn.style.background = preset.hex;
        btn.style.cursor = "pointer";
        btn.style.padding = "0 10px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "space-between";
        btn.style.gap = "8px";
        btn.style.outline =
          preset.hex === activeHex
            ? "2px solid #ffffff"
            : "2px solid transparent";
        btn.style.outlineOffset = "1px";

        const nameLabel = document.createElement("span");
        nameLabel.style.fontSize = "11px";
        nameLabel.style.fontWeight = "600";
        nameLabel.style.color = "#ffffff";
        nameLabel.style.textShadow = "0 1px 2px rgba(0,0,0,0.8)";
        nameLabel.style.whiteSpace = "nowrap";
        nameLabel.style.overflow = "hidden";
        nameLabel.style.textOverflow = "ellipsis";
        nameLabel.textContent = preset.name;

        const hexTag = document.createElement("span");
        hexTag.style.fontSize = "10px";
        hexTag.style.fontFamily = "monospace";
        hexTag.style.color = "rgba(255,255,255,0.85)";
        hexTag.style.textShadow = "0 1px 2px rgba(0,0,0,0.8)";
        hexTag.style.flexShrink = "0";
        hexTag.textContent = preset.hex.toUpperCase();

        btn.append(nameLabel, hexTag);

        btn.addEventListener("click", async () => {
          activeHex = preset.hex;
          setDefaultHex(preset.hex);
          rebuildSwatches();
          await applyColorToSelection(preset.hex);
        });

        row.appendChild(btn);

        if (!preset.builtIn) {
          const delBtn = document.createElement("button");
          delBtn.title = "Delete saved color";
          delBtn.textContent = "×";
          delBtn.style.width = "24px";
          delBtn.style.height = "30px";
          delBtn.style.flexShrink = "0";
          delBtn.style.borderRadius = "6px";
          delBtn.style.border = "1px solid #374151";
          delBtn.style.background = "#141519";
          delBtn.style.color = "#9ca3af";
          delBtn.style.fontSize = "14px";
          delBtn.style.lineHeight = "1";
          delBtn.style.padding = "0";
          delBtn.style.cursor = "pointer";

          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const remaining = getSavedColors().filter(
              (c) => !c.builtIn && c.id !== preset.id
            );
            saveCustomColors(remaining);
            if (activeHex === preset.hex) {
              activeHex = STARTING_COLORS[0].hex;
              setDefaultHex(activeHex);
            }
            rebuildSwatches();
          });

          row.appendChild(delBtn);
        }

        colorList.appendChild(row);
      });
    }

    // Custom Color Section
    const customSection = document.createElement("div");
    customSection.style.borderTop = "1px solid #2e3038";
    customSection.style.paddingTop = "10px";
    customSection.style.marginBottom = "10px";

    const customLabel = document.createElement("div");
    customLabel.style.fontSize = "11px";
    customLabel.style.color = "#9ca3af";
    customLabel.style.marginBottom = "6px";
    customLabel.textContent = "Add Custom Color";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Color name (e.g. Bile Yellow)";
    nameInput.style.width = "100%";
    nameInput.style.padding = "6px 8px";
    nameInput.style.marginBottom = "6px";
    nameInput.style.borderRadius = "6px";
    nameInput.style.border = "1px solid #374151";
    nameInput.style.background = "#141519";
    nameInput.style.color = "#f3f4f6";
    nameInput.style.fontSize = "11px";
    nameInput.style.outline = "none";

    const hexRow = document.createElement("div");
    hexRow.style.display = "flex";
    hexRow.style.gap = "6px";
    hexRow.style.alignItems = "center";

    const pickerInput = document.createElement("input");
    pickerInput.type = "color";
    pickerInput.value = "#06b6d4";
    pickerInput.style.width = "30px";
    pickerInput.style.height = "28px";
    pickerInput.style.padding = "0";
    pickerInput.style.border = "1px solid #374151";
    pickerInput.style.borderRadius = "6px";
    pickerInput.style.background = "transparent";
    pickerInput.style.cursor = "pointer";

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.value = "#06b6d4";
    hexInput.placeholder = "#06b6d4";
    hexInput.style.flex = "1";
    hexInput.style.minWidth = "0";
    hexInput.style.padding = "6px 8px";
    hexInput.style.borderRadius = "6px";
    hexInput.style.border = "1px solid #374151";
    hexInput.style.background = "#141519";
    hexInput.style.color = "#f3f4f6";
    hexInput.style.fontSize = "11px";
    hexInput.style.fontFamily = "monospace";
    hexInput.style.outline = "none";

    pickerInput.addEventListener("input", () => {
      hexInput.value = pickerInput.value;
      hexInput.style.borderColor = "#374151";
    });

    hexInput.addEventListener("input", () => {
      const norm = normalizeHex(hexInput.value);
      if (norm) {
        pickerInput.value = norm;
        hexInput.style.borderColor = "#374151";
      }
    });

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.padding = "6px 10px";
    saveBtn.style.borderRadius = "6px";
    saveBtn.style.border = "none";
    saveBtn.style.background = "#3b82f6";
    saveBtn.style.color = "#ffffff";
    saveBtn.style.fontSize = "11px";
    saveBtn.style.fontWeight = "600";
    saveBtn.style.cursor = "pointer";

    saveBtn.addEventListener("click", async () => {
      if ((await OBR.player.getRole()) !== "GM") return;

      const norm = normalizeHex(hexInput.value);
      if (!norm) {
        hexInput.style.borderColor = "#ef4444";
        return;
      }

      const customName = nameInput.value.trim() || norm.toUpperCase();
      const existingCustom = getSavedColors().filter((c) => !c.builtIn);
      const newEntry: SavedGooColor = {
        id: `custom-${Date.now()}`,
        name: customName,
        hex: norm,
      };

      saveCustomColors([...existingCustom, newEntry]);
      nameInput.value = "";
      activeHex = norm;
      setDefaultHex(norm);
      rebuildSwatches();
      colorList.scrollTop = colorList.scrollHeight;
      await applyColorToSelection(norm);
    });

    hexRow.append(pickerInput, hexInput, saveBtn);
    customSection.append(customLabel, nameInput, hexRow);

    // Remove Goo Button
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove Goo from Selected";
    removeBtn.style.width = "100%";
    removeBtn.style.padding = "7px 10px";
    removeBtn.style.borderRadius = "6px";
    removeBtn.style.border = "1px solid #4b5563";
    removeBtn.style.background = "#272930";
    removeBtn.style.color = "#f87171";
    removeBtn.style.fontSize = "11px";
    removeBtn.style.fontWeight = "600";
    removeBtn.style.cursor = "pointer";

    removeBtn.addEventListener("click", async () => {
      if ((await OBR.player.getRole()) !== "GM") return;

      const selection = await OBR.player.getSelection();
      if (!selection || selection.length === 0) return;

      await OBR.scene.items.updateItems(selection, (items) => {
        for (const item of items) {
          delete item.metadata[META_KEY];
          delete item.metadata[COLOR_META_KEY];
        }
      });
    });

    const updateSelectionStatus = async () => {
      const selection = await OBR.player.getSelection();
      const count = selection ? selection.length : 0;
      statusBadge.textContent =
        count === 0
          ? "No selection"
          : `${count} token${count === 1 ? "" : "s"} selected`;
    };

    updateSelectionStatus();
    rebuildSwatches();
    container.append(headerRow, colorList, customSection, removeBtn);
    document.body.replaceChildren(container);
    return updateSelectionStatus;
  }

  let updateStatusFn =
    currentRole === "GM" ? renderGmEditorView() : (renderLockedPlayerView(), null);

  OBR.player.onChange((player) => {
    if (player.role !== currentRole) {
      currentRole = player.role;
      updateStatusFn =
        currentRole === "GM"
          ? renderGmEditorView()
          : (renderLockedPlayerView(), null);
    } else if (updateStatusFn) {
      updateStatusFn();
    }
  });
}

OBR.onReady(async () => {
  if (window.location.hash === "#popover") {
    await renderPopoverUI();
    return;
  }

  const initialRole = await OBR.player.getRole();
  await syncContextMenuForRole(initialRole);

  OBR.player.onChange((player) => {
    syncContextMenuForRole(player.role);
  });

  if (await OBR.scene.isReady()) {
    syncGooEffect();
  }

  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      syncGooEffect();
    }
  });

  OBR.scene.items.onChange(() => {
    syncGooEffect();
  });
});