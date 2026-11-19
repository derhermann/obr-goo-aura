import OBR, {
  buildEffect,
  isImage,
  type Effect,
  type Image,
  type Matrix,
  type Uniform,
} from "@owlbear-rodeo/sdk";

const EXTENSION_ID = "com.custom.goo-aura";
const META_KEY = `${EXTENSION_ID}/enabled`;
const COLOR_META_KEY = `${EXTENSION_ID}/color`;     // "#rrggbbaa"
const RIM_META_KEY = `${EXTENSION_ID}/rim`;         // 0.0 to 1.0
const WOBBLE_META_KEY = `${EXTENSION_ID}/wobble`;   // 0.0 to 1.0
const RADIUS_META_KEY = `${EXTENSION_ID}/radius`;   // Base radius in grid squares
const GROUP_META_KEY = `${EXTENSION_ID}/group`;
const KEEP_WHEN_HIDDEN_META_KEY = `${EXTENSION_ID}/keep-when-hidden`;
const EFFECT_META_KEY = `${EXTENSION_ID}/is-goo-effect`;

const TOGGLE_MENU_ID = `${EXTENSION_ID}/toggle`;
const HIDDEN_BEHAVIOR_MENU_ID = `${EXTENSION_ID}/toggle-hidden-behavior`;

const CUSTOM_COLORS_STORAGE_KEY = `${EXTENSION_ID}/custom-colors`;
const BUILTIN_PROPS_STORAGE_KEY = `${EXTENSION_ID}/builtin-props`;
const DEFAULT_STYLE_STORAGE_KEY = `${EXTENSION_ID}/default-style`;
const DEFAULT_RADIUS_STORAGE_KEY = `${EXTENSION_ID}/default-radius`;
const GROUPS_STORAGE_KEY = `${EXTENSION_ID}/groups`;
const ACTIVE_TARGET_STORAGE_KEY = `${EXTENSION_ID}/active-target`;

const NUM_MATRICES = 20; // 20 matrices × 2 monsters per matrix = 40 monsters max
const MAX_TOKENS = NUM_MATRICES * 2;
const NUM_PALETTE_MATRICES = 4; // 4 RGB matrices + 4 FX matrices = 12 simultaneous styles
const MAX_ACTIVE_PALETTE = NUM_PALETTE_MATRICES * 3;

const DEFAULT_RADIUS_MULTIPLIER = 1.25; // Default base radius in grid squares
const MIN_RADIUS_MULTIPLIER = 0.5;
const MAX_RADIUS_MULTIPLIER = 4.0;
const DEFAULT_OPACITY = 0.42;
const DEFAULT_RIM = 0.35;
const DEFAULT_WOBBLE = 0.25;

interface SavedGooColor {
  id: string;
  name: string;
  hex: string;     // "#rrggbb"
  opacity: number; // 0.0 to 1.0
  rim: number;     // 0.0 to 1.0
  wobble: number;  // 0.0 to 1.0
  builtIn?: boolean;
}

interface SavedGooGroup {
  id: string;
  name: string;
  rgbaHex: string;          // "#rrggbbaa"
  rim: number;              // 0.0 to 1.0
  wobble: number;           // 0.0 to 1.0
  radiusMultiplier: number; // Base radius in grid squares
  keepWhenHidden?: boolean;
  builtIn?: boolean;
}

const STARTING_COLORS: SavedGooColor[] = [
  { id: "builtin-acid",    name: "Acid Green",    hex: "#2ed959", opacity: DEFAULT_OPACITY, rim: 0.40, wobble: 0.30, builtIn: true },
  { id: "builtin-crimson", name: "Crimson Blood", hex: "#ef4444", opacity: DEFAULT_OPACITY, rim: 0.35, wobble: 0.25, builtIn: true },
  { id: "builtin-arcane",  name: "Arcane Purple", hex: "#a855f7", opacity: DEFAULT_OPACITY, rim: 0.50, wobble: 0.35, builtIn: true },
];

const STARTING_GROUPS: SavedGooGroup[] = [
  { id: "group-1", name: "Group 1", rgbaHex: "#2ed9596b", rim: 0.40, wobble: 0.30, radiusMultiplier: DEFAULT_RADIUS_MULTIPLIER, keepWhenHidden: false, builtIn: true },
  { id: "group-2", name: "Group 2", rgbaHex: "#ef44446b", rim: 0.35, wobble: 0.25, radiusMultiplier: DEFAULT_RADIUS_MULTIPLIER, keepWhenHidden: false, builtIn: true },
  { id: "group-3", name: "Group 3", rgbaHex: "#a855f76b", rim: 0.50, wobble: 0.35, radiusMultiplier: DEFAULT_RADIUS_MULTIPLIER, keepWhenHidden: false, builtIn: true },
  { id: "group-4", name: "Group 4", rgbaHex: "#06b6d46b", rim: 0.40, wobble: 0.25, radiusMultiplier: DEFAULT_RADIUS_MULTIPLIER, keepWhenHidden: false, builtIn: true },
];

const matrixUniforms = Array.from(
  { length: NUM_MATRICES },
  (_, m) => `uniform float3x3 uM${m};`
).join("\n");

const paletteUniforms = Array.from(
  { length: NUM_PALETTE_MATRICES },
  (_, p) => `uniform float3x3 uPalCol${p};\nuniform float3x3 uPalFx${p};`
).join("\n");

// Each 3x3 matrix packs 2 monsters across its first 8 floats: [x, y, styleIndex, radius]
const slotDefs: { pos: string; style: string; rad: string }[] = [];
for (let m = 0; m < NUM_MATRICES; m++) {
  slotDefs.push({
    pos: `float2(uM${m}[0][0], uM${m}[0][1])`,
    style: `uM${m}[0][2]`,
    rad: `uM${m}[1][0]`,
  });
  slotDefs.push({
    pos: `float2(uM${m}[1][1], uM${m}[1][2])`,
    style: `uM${m}[2][0]`,
    rad: `uM${m}[2][1]`,
  });
}

const mergeSteps = slotDefs
  .slice(1)
  .map(
    (slot, i) => `
    if (uCount > ${i + 1.5}) {
        float ri = ${slot.rad};
        half4 ci = getStyleColor(${slot.style});
        half3 fxi = getStyleFx(${slot.style});
        float di = evalBlobDist(coord, ${slot.pos}, ri, float(fxi.z), ${(i + 1) * 1.73});
        float k = max(min(curRad, ri) * 0.65, 1.0);
        float h = clamp(0.5 + 0.5 * (di - d) / k, 0.0, 1.0);
        d = mix(di, d, h) - k * h * (1.0 - h);
        col = mix(ci, col, half(h));
        curRim = mix(float(fxi.y), curRim, h);
        curRad = mix(ri, curRad, h);
    }`
  )
  .join("\n");

const paletteColorLookupLines: string[] = [];
const paletteFxLookupLines: string[] = [];
for (let p = 0; p < NUM_PALETTE_MATRICES; p++) {
  for (let r = 0; r < 3; r++) {
    const idx = p * 3 + r;
    const isLast = idx === MAX_ACTIVE_PALETTE - 1;
    const prefix = isLast ? "    return" : `    if (idx < ${idx + 0.5}) return`;
    paletteColorLookupLines.push(
      `${prefix} half4(uPalCol${p}[${r}][0], uPalCol${p}[${r}][1], uPalCol${p}[${r}][2], uPalFx${p}[${r}][0]);`
    );
    paletteFxLookupLines.push(
      `${prefix} half3(uPalFx${p}[${r}][0], uPalFx${p}[${r}][1], uPalFx${p}[${r}][2]);`
    );
  }
}

const GOO_SKSL = `
${matrixUniforms}

${paletteUniforms}

uniform float uCount;
uniform float uTime;

half4 getStyleColor(float idx) {
${paletteColorLookupLines.join("\n")}
}

// Returns half3(opacity, rimHighlight, wobbleStrength)
half3 getStyleFx(float idx) {
${paletteFxLookupLines.join("\n")}
}

// Seamless multi-harmonic organic membrane undulation
float evalBlobDist(float2 coord, float2 center, float radius, float wobble, float phase) {
    float2 delta = coord - center;
    float dist = length(delta);
    if (wobble <= 0.001 || dist <= 0.001) {
        return dist - radius;
    }

    float2 u = delta / dist;
    float c2 = u.x * u.x - u.y * u.y;
    float s2 = 2.0 * u.x * u.y;
    float c3 = u.x * (4.0 * u.x * u.x - 3.0);
    float s3 = u.y * (3.0 - 4.0 * u.y * u.y);

    float t1 = uTime * 1.15 + phase;
    float t2 = -uTime * 0.85 + phase * 1.7;
    float t3 = uTime * 1.65 + phase * 2.3;

    float wave = 0.50 * (c2 * cos(t1) + s2 * sin(t1))
               + 0.35 * (c3 * cos(t2) + s3 * sin(t2))
               + 0.15 * sin(t3 + (u.x + u.y) * 3.0);

    float amp = radius * 0.14 * wobble;
    return dist - (radius + wave * amp);
}

half4 main(float2 coord) {
    if (uCount < 0.5) {
        return half4(0.0);
    }

    float curRad = ${slotDefs[0].rad};
    half4 col = getStyleColor(${slotDefs[0].style});
    half3 fx0 = getStyleFx(${slotDefs[0].style});
    float curRim = float(fx0.y);
    float d = evalBlobDist(coord, ${slotDefs[0].pos}, curRad, float(fx0.z), 0.0);
${mergeSteps}

    // Crisp anti-aliased liquid edge
    float fillMask = 1.0 - smoothstep(-1.5, 1.5, d);
    float baseAlpha = fillMask * float(col.a);

    // Translucent liquid meniscus rim highlight along the inner edge
    float rimWidth = mix(2.5, 7.5, curRim);
    float innerBand = smoothstep(-rimWidth, -1.0, d);
    float outerCut = 1.0 - smoothstep(-0.5, 1.2, d);
    float rimMask = innerBand * outerCut * curRim;

    float finalAlpha = clamp(baseAlpha + rimMask * 0.48, 0.0, 1.0);
    half3 highlightRgb = min(col.rgb * half(1.45) + half3(0.32), half3(1.0));
    half3 finalRgb = mix(col.rgb, highlightRgb, half(rimMask * 0.85));

    // Skia requires premultiplied alpha
    return half4(finalRgb * half(finalAlpha), half(finalAlpha));
}
`;

function clampUnit(val: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(1, Math.max(0, val));
}

function clampRadiusMultiplier(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_RADIUS_MULTIPLIER;
  return Math.min(MAX_RADIUS_MULTIPLIER, Math.max(MIN_RADIUS_MULTIPLIER, val));
}

// Calculates how many grid cells wide/tall a token is (1.0 for 1x1, 2.0 for 2x2, etc.)
function getTokenGridSizeMultiplier(item: Image): number {
  const scaleX = Math.abs(item.scale?.x ?? 1) || 1;
  const scaleY = Math.abs(item.scale?.y ?? 1) || 1;

  const imgW = item.image?.width;
  const imgH = item.image?.height;
  const itemDpi = item.grid?.dpi;

  if (
    typeof imgW === "number" &&
    typeof imgH === "number" &&
    typeof itemDpi === "number" &&
    imgW > 0 &&
    imgH > 0 &&
    itemDpi > 0
  ) {
    const cellsW = (imgW / itemDpi) * scaleX;
    const cellsH = (imgH / itemDpi) * scaleY;
    const avgCells = (cellsW + cellsH) / 2;
    return Math.min(10, Math.max(0.25, avgCells));
  }

  return Math.min(10, Math.max(0.25, Math.max(scaleX, scaleY)));
}

function normalizeRgbHex(input: string): string | null {
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

function formatRgbaHex(rgbHex: string, opacity: number): string {
  const cleanRgb = normalizeRgbHex(rgbHex) ?? STARTING_COLORS[0].hex;
  const alphaByte = Math.round(clampUnit(opacity, DEFAULT_OPACITY) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${cleanRgb}${alphaByte}`;
}

function parseRgbaHex(
  input: unknown,
  fallbackOpacity = DEFAULT_OPACITY
): { hex: string; opacity: number } {
  if (typeof input !== "string") {
    return { hex: STARTING_COLORS[0].hex, opacity: fallbackOpacity };
  }
  const trimmed = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) {
    const hex = `#${trimmed.slice(0, 6).toLowerCase()}`;
    const opacity = parseInt(trimmed.slice(6, 8), 16) / 255;
    return { hex, opacity: clampUnit(opacity, fallbackOpacity) };
  }
  if (/^[0-9a-fA-F]{4}$/.test(trimmed)) {
    const hex = `#${trimmed[0]}${trimmed[0]}${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}`.toLowerCase();
    const opacity = parseInt(`${trimmed[3]}${trimmed[3]}`, 16) / 255;
    return { hex, opacity: clampUnit(opacity, fallbackOpacity) };
  }
  const rgbOnly = normalizeRgbHex(trimmed);
  if (rgbOnly) {
    return { hex: rgbOnly, opacity: fallbackOpacity };
  }
  return { hex: STARTING_COLORS[0].hex, opacity: fallbackOpacity };
}

function hexToRgbFloat3(rgbHex: string): [number, number, number] {
  const clean = normalizeRgbHex(rgbHex) ?? STARTING_COLORS[0].hex;
  const num = parseInt(clean.slice(1), 16);
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255,
  ];
}

interface BuiltInStyleOverride {
  opacity?: number;
  rim?: number;
  wobble?: number;
}

function getBuiltInOverrides(): Record<string, BuiltInStyleOverride> {
  try {
    const raw = localStorage.getItem(BUILTIN_PROPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBuiltInOverride(id: string, patch: BuiltInStyleOverride) {
  const current = getBuiltInOverrides();
  current[id] = { ...(current[id] ?? {}), ...patch };
  localStorage.setItem(BUILTIN_PROPS_STORAGE_KEY, JSON.stringify(current));
}

function getSavedColors(): SavedGooColor[] {
  const overrides = getBuiltInOverrides();
  const builtIns = STARTING_COLORS.map((c) => {
    const ov = overrides[c.id];
    return {
      ...c,
      opacity:
        typeof ov?.opacity === "number"
          ? clampUnit(ov.opacity, c.opacity)
          : c.opacity,
      rim: typeof ov?.rim === "number" ? clampUnit(ov.rim, c.rim) : c.rim,
      wobble:
        typeof ov?.wobble === "number"
          ? clampUnit(ov.wobble, c.wobble)
          : c.wobble,
    };
  });

  try {
    const raw = localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY);
    if (!raw) return builtIns;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return builtIns;
    const custom = parsed
      .filter(
        (c) =>
          c &&
          typeof c.id === "string" &&
          typeof c.name === "string" &&
          typeof c.hex === "string" &&
          normalizeRgbHex(c.hex) !== null
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        hex: normalizeRgbHex(c.hex)!,
        opacity: clampUnit(Number(c.opacity), DEFAULT_OPACITY),
        rim: clampUnit(Number(c.rim), DEFAULT_RIM),
        wobble: clampUnit(Number(c.wobble), DEFAULT_WOBBLE),
      }));
    return [...builtIns, ...custom];
  } catch {
    return builtIns;
  }
}

function saveCustomColors(customColors: SavedGooColor[]) {
  localStorage.setItem(
    CUSTOM_COLORS_STORAGE_KEY,
    JSON.stringify(customColors.filter((c) => !c.builtIn))
  );
}

function getSavedGroups(): SavedGooGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return STARTING_GROUPS.map((g) => ({ ...g }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return STARTING_GROUPS.map((g) => ({ ...g }));
    }
    const valid: SavedGooGroup[] = [];
    for (const g of parsed) {
      if (!g || typeof g.id !== "string" || typeof g.name !== "string") continue;
      const rawColor = typeof g.rgbaHex === "string" ? g.rgbaHex : g.hex;
      if (typeof rawColor !== "string") continue;
      const { hex, opacity } = parseRgbaHex(rawColor);
      valid.push({
        id: g.id,
        name: g.name,
        rgbaHex: formatRgbaHex(hex, opacity),
        rim: clampUnit(Number(g.rim), DEFAULT_RIM),
        wobble: clampUnit(Number(g.wobble), DEFAULT_WOBBLE),
        radiusMultiplier:
          typeof g.radiusMultiplier === "number"
            ? clampRadiusMultiplier(g.radiusMultiplier)
            : DEFAULT_RADIUS_MULTIPLIER,
        keepWhenHidden: Boolean(g.keepWhenHidden),
        builtIn: Boolean(g.builtIn),
      });
    }
    return valid.length > 0 ? valid : STARTING_GROUPS.map((g) => ({ ...g }));
  } catch {
    return STARTING_GROUPS.map((g) => ({ ...g }));
  }
}

function saveGroups(groups: SavedGooGroup[]) {
  localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
}

interface DefaultStyleState {
  rgbaHex: string;
  rim: number;
  wobble: number;
}

function getDefaultStyle(): DefaultStyleState {
  try {
    const raw = localStorage.getItem(DEFAULT_STYLE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const { hex, opacity } = parseRgbaHex(parsed?.rgbaHex);
      return {
        rgbaHex: formatRgbaHex(hex, opacity),
        rim: clampUnit(Number(parsed?.rim), DEFAULT_RIM),
        wobble: clampUnit(Number(parsed?.wobble), DEFAULT_WOBBLE),
      };
    }
  } catch {
    // Fall through to defaults
  }
  return {
    rgbaHex: formatRgbaHex(STARTING_COLORS[0].hex, DEFAULT_OPACITY),
    rim: DEFAULT_RIM,
    wobble: DEFAULT_WOBBLE,
  };
}

function setDefaultStyle(patch: Partial<DefaultStyleState>) {
  const current = getDefaultStyle();
  const next: DefaultStyleState = {
    rgbaHex: patch.rgbaHex ?? current.rgbaHex,
    rim:
      typeof patch.rim === "number"
        ? clampUnit(patch.rim, current.rim)
        : current.rim,
    wobble:
      typeof patch.wobble === "number"
        ? clampUnit(patch.wobble, current.wobble)
        : current.wobble,
  };
  localStorage.setItem(DEFAULT_STYLE_STORAGE_KEY, JSON.stringify(next));
}

function getDefaultRadiusMultiplier(): number {
  const raw = localStorage.getItem(DEFAULT_RADIUS_STORAGE_KEY);
  if (raw === null) return DEFAULT_RADIUS_MULTIPLIER;
  return clampRadiusMultiplier(Number(raw));
}

function setDefaultRadiusMultiplier(mult: number) {
  localStorage.setItem(
    DEFAULT_RADIUS_STORAGE_KEY,
    String(clampRadiusMultiplier(mult))
  );
}

function getStoredActiveTarget(): string {
  return localStorage.getItem(ACTIVE_TARGET_STORAGE_KEY) || "group-1";
}

function setStoredActiveTarget(target: string) {
  localStorage.setItem(ACTIVE_TARGET_STORAGE_KEY, target);
}

// --- WOBBLE ANIMATION LOOP (Only runs when at least one active token has wobble > 0) ---
const ANIMATION_EPOCH = performance.now();
let wobbleAnimTimer: number | undefined;
let activeEffectId: string | null = null;
let hasActiveWobble = false;
let isSyncing = false;
let syncQueued = false;

function getShaderTimeSeconds(): number {
  return ((performance.now() - ANIMATION_EPOCH) / 1000) % 628.3185;
}

function updateWobbleAnimationLoop() {
  if (hasActiveWobble && activeEffectId) {
    if (wobbleAnimTimer === undefined) {
      wobbleAnimTimer = window.setInterval(async () => {
        if (!hasActiveWobble || !activeEffectId || isSyncing) return;
        const t = getShaderTimeSeconds();
        try {
          await OBR.scene.local.updateItems<Effect>(
            [activeEffectId],
            (draft) => {
              const effect = draft[0];
              if (!effect) return;
              const timeUniform = effect.uniforms.find(
                (u) => u.name === "uTime"
              );
              if (timeUniform) {
                timeUniform.value = t;
              }
            }
          );
        } catch {
          // Ignore transient scene transitions
        }
      }, 40); // ~25 FPS smooth organic undulation
    }
  } else if (wobbleAnimTimer !== undefined) {
    window.clearInterval(wobbleAnimTimer);
    wobbleAnimTimer = undefined;
  }
}

interface ActiveStyleEntry {
  key: string;
  rgb: [number, number, number];
  opacity: number;
  rim: number;
  wobble: number;
}

// Runs for both GMs and Players so everyone sees the rendered goo
async function syncGooEffect() {
  if (isSyncing) {
    syncQueued = true;
    return;
  }
  isSyncing = true;

  try {
    const sceneReady = await OBR.scene.isReady();
    if (!sceneReady) {
      hasActiveWobble = false;
      activeEffectId = null;
      updateWobbleAnimationLoop();
      return;
    }

    const [items, localItems, dpi] = await Promise.all([
      OBR.scene.items.getItems(),
      OBR.scene.local.getItems(),
      OBR.scene.grid.getDpi(),
    ]);

    const activeStyles: ActiveStyleEntry[] = [];
    const tokens: {
      x: number;
      y: number;
      styleIdx: number;
      radius: number;
    }[] = [];
    let anyWobble = false;

    for (const item of items) {
      if (isImage(item) && item.metadata[META_KEY]) {
        const keepWhenHidden = Boolean(item.metadata[KEEP_WHEN_HIDDEN_META_KEY]);
        if (!item.visible && !keepWhenHidden) {
          continue;
        }

        const { hex, opacity } = parseRgbaHex(item.metadata[COLOR_META_KEY]);
        const rim =
          typeof item.metadata[RIM_META_KEY] === "number"
            ? clampUnit(item.metadata[RIM_META_KEY], DEFAULT_RIM)
            : DEFAULT_RIM;
        const wobble =
          typeof item.metadata[WOBBLE_META_KEY] === "number"
            ? clampUnit(item.metadata[WOBBLE_META_KEY], DEFAULT_WOBBLE)
            : DEFAULT_WOBBLE;

        if (wobble > 0.005) {
          anyWobble = true;
        }

        const styleKey = `${hex}|${opacity.toFixed(3)}|${rim.toFixed(3)}|${wobble.toFixed(3)}`;
        let styleIdx = activeStyles.findIndex((s) => s.key === styleKey);
        if (styleIdx === -1) {
          if (activeStyles.length < MAX_ACTIVE_PALETTE) {
            styleIdx = activeStyles.length;
            activeStyles.push({
              key: styleKey,
              rgb: hexToRgbFloat3(hex),
              opacity,
              rim,
              wobble,
            });
          } else {
            styleIdx = activeStyles.length - 1;
          }
        }

        const rawRadiusMult = item.metadata[RADIUS_META_KEY];
        const baseRadiusMult =
          typeof rawRadiusMult === "number"
            ? clampRadiusMultiplier(rawRadiusMult)
            : DEFAULT_RADIUS_MULTIPLIER;

        const tokenSizeScale = getTokenGridSizeMultiplier(item);
        const pixelRadius = dpi * baseRadiusMult * tokenSizeScale;

        tokens.push({
          x: item.position.x,
          y: item.position.y,
          styleIdx,
          radius: pixelRadius,
        });
        if (tokens.length >= MAX_TOKENS) break;
      }
    }

    const existingEffect = localItems.find(
      (item) => item.metadata[EFFECT_META_KEY]
    );

    if (tokens.length === 0) {
      hasActiveWobble = false;
      activeEffectId = null;
      updateWobbleAnimationLoop();
      if (existingEffect) {
        await OBR.scene.local.deleteItems([existingEffect.id]);
      }
      return;
    }

    // Calculate dynamic bounding box accounting for each token's scaled radius + wobble + liquid bridge
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const t of tokens) {
      const pad = t.radius * 1.95 + 6;
      if (t.x - pad < minX) minX = t.x - pad;
      if (t.y - pad < minY) minY = t.y - pad;
      if (t.x + pad > maxX) maxX = t.x + pad;
      if (t.y + pad > maxY) maxY = t.y + pad;
    }

    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);

    const uniforms: Uniform[] = [
      { name: "uCount", value: tokens.length },
      { name: "uTime", value: anyWobble ? getShaderTimeSeconds() : 0 },
    ];

    const fallbackStyle: ActiveStyleEntry = {
      key: "fallback",
      rgb: hexToRgbFloat3(STARTING_COLORS[0].hex),
      opacity: DEFAULT_OPACITY,
      rim: DEFAULT_RIM,
      wobble: DEFAULT_WOBBLE,
    };

    // Pack up to 12 styles into 4 RGB matrices + 4 FX matrices
    for (let p = 0; p < NUM_PALETTE_MATRICES; p++) {
      const s0 = activeStyles[p * 3 + 0] ?? fallbackStyle;
      const s1 = activeStyles[p * 3 + 1] ?? fallbackStyle;
      const s2 = activeStyles[p * 3 + 2] ?? fallbackStyle;

      const colMat: Matrix = [...s0.rgb, ...s1.rgb, ...s2.rgb];
      const fxMat: Matrix = [
        s0.opacity, s0.rim, s0.wobble,
        s1.opacity, s1.rim, s1.wobble,
        s2.opacity, s2.rim, s2.wobble,
      ];

      uniforms.push({ name: `uPalCol${p}`, value: colMat });
      uniforms.push({ name: `uPalFx${p}`, value: fxMat });
    }

    // Pack 2 monsters per 9-element Matrix: [x, y, styleIndex, radius] × 2 + [0]
    for (let m = 0; m < NUM_MATRICES; m++) {
      const t0 = tokens[m * 2 + 0];
      const t1 = tokens[m * 2 + 1];

      const mat: Matrix = [
        t0 ? t0.x - minX : 0,
        t0 ? t0.y - minY : 0,
        t0 ? t0.styleIdx : 0,
        t0 ? t0.radius : 0,
        t1 ? t1.x - minX : 0,
        t1 ? t1.y - minY : 0,
        t1 ? t1.styleIdx : 0,
        t1 ? t1.radius : 0,
        0,
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
      activeEffectId = effect.id;
    } else {
      activeEffectId = existingEffect.id;
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

    hasActiveWobble = anyWobble;
    updateWobbleAnimationLoop();
  } finally {
    isSyncing = false;
    if (syncQueued) {
      syncQueued = false;
      syncGooEffect();
    }
  }
}

let contextMenusRegistered = false;

async function syncContextMenuForRole(role: "GM" | "PLAYER") {
  if (role === "GM" && !contextMenusRegistered) {
    contextMenusRegistered = true;

    // 1. Enable / Disable Goo Aura
    await OBR.contextMenu.create({
      id: TOGGLE_MENU_ID,
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
        const defStyle = getDefaultStyle();
        const defaultRadius = getDefaultRadiusMultiplier();

        await OBR.scene.items.updateItems(context.items, (items) => {
          for (const item of items) {
            if (shouldEnable) {
              item.metadata[META_KEY] = true;
              if (typeof item.metadata[COLOR_META_KEY] !== "string") {
                item.metadata[COLOR_META_KEY] = defStyle.rgbaHex;
              }
              if (typeof item.metadata[RIM_META_KEY] !== "number") {
                item.metadata[RIM_META_KEY] = defStyle.rim;
              }
              if (typeof item.metadata[WOBBLE_META_KEY] !== "number") {
                item.metadata[WOBBLE_META_KEY] = defStyle.wobble;
              }
              if (typeof item.metadata[RADIUS_META_KEY] !== "number") {
                item.metadata[RADIUS_META_KEY] = defaultRadius;
              }
            } else {
              delete item.metadata[META_KEY];
              delete item.metadata[COLOR_META_KEY];
              delete item.metadata[RIM_META_KEY];
              delete item.metadata[WOBBLE_META_KEY];
              delete item.metadata[RADIUS_META_KEY];
              delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
            }
          }
        });
      },
    });

    // 2. Toggle whether Goo stays visible when the token is hidden
    await OBR.contextMenu.create({
      id: HIDDEN_BEHAVIOR_MENU_ID,
      icons: [
        {
          icon: "/icon.svg",
          label: "Keep Goo When Hidden",
          filter: {
            every: [
              { key: "layer", value: "CHARACTER" },
              { key: ["metadata", META_KEY], value: true },
              { key: ["metadata", KEEP_WHEN_HIDDEN_META_KEY], value: undefined },
            ],
          },
        },
        {
          icon: "/icon.svg",
          label: "Hide Goo With Token",
          filter: {
            every: [
              { key: "layer", value: "CHARACTER" },
              { key: ["metadata", META_KEY], value: true },
            ],
          },
        },
      ],
      async onClick(context) {
        if ((await OBR.player.getRole()) !== "GM") return;

        const shouldKeep = context.items.some(
          (item) => !item.metadata[KEEP_WHEN_HIDDEN_META_KEY]
        );
        await OBR.scene.items.updateItems(context.items, (items) => {
          for (const item of items) {
            if (shouldKeep) {
              item.metadata[KEEP_WHEN_HIDDEN_META_KEY] = true;
            } else {
              delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
            }
          }
        });
      },
    });
  } else if (role !== "GM" && contextMenusRegistered) {
    contextMenusRegistered = false;
    await Promise.all([
      OBR.contextMenu.remove(TOGGLE_MENU_ID),
      OBR.contextMenu.remove(HIDDEN_BEHAVIOR_MENU_ID),
    ]);
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
    .goo-scroll {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }
    .goo-scroll::-webkit-scrollbar {
      width: 5px;
      height: 0px;
    }
    .goo-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .goo-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 999px;
    }
    .goo-scroll::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
    }
    .goo-group-name-input {
      background: transparent;
      border: 1px solid transparent;
      color: #f3f4f6;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 4px;
      border-radius: 4px;
      width: 100%;
      min-width: 0;
      outline: none;
    }
    .goo-group-name-input:hover {
      border-color: rgba(255, 255, 255, 0.15);
    }
    .goo-group-name-input:focus {
      background: #141519;
      border-color: #3b82f6;
    }
    .goo-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 999px;
      background: #2e3038;
      outline: none;
      cursor: pointer;
    }
    .goo-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #3b82f6;
      border: 2px solid #ffffff;
      cursor: pointer;
    }
    .goo-slider::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #3b82f6;
      border: 2px solid #ffffff;
      cursor: pointer;
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

  function createCompactSlider(
    labelText: string,
    min: number,
    max: number,
    step: number,
    initialValue: number,
    formatValue: (v: number) => string
  ) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "3px";

    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.justifyContent = "space-between";
    topRow.style.alignItems = "center";

    const label = document.createElement("span");
    label.style.fontSize = "10.5px";
    label.style.color = "#d1d5db";
    label.textContent = labelText;

    const valueTag = document.createElement("span");
    valueTag.style.fontSize = "10.5px";
    valueTag.style.fontFamily = "monospace";
    valueTag.style.color = "#93c5fd";
    valueTag.textContent = formatValue(initialValue);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "goo-slider";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(initialValue);

    topRow.append(label, valueTag);
    row.append(topRow, slider);

    return { row, slider, valueTag };
  }

  function renderGmEditorView() {
    const container = document.createElement("div");
    container.style.padding = "10px 12px";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100vh";

    const initialDef = getDefaultStyle();
    const initialRgba = parseRgbaHex(initialDef.rgbaHex);
    let activeHex = initialRgba.hex;
    let activeOpacity = initialRgba.opacity;
    let activeRim = initialDef.rim;
    let activeWobble = initialDef.wobble;
    let editingColorId: string | null =
      getSavedColors().find((c) => c.hex === activeHex)?.id ?? null;

    let activeTarget = getStoredActiveTarget(); // "selection" or group.id
    let groupCounts: Record<string, number> = {};
    let selectedCount = 0;
    let selectionKeepWhenHidden = false;
    let selectionRadiusMultiplier = getDefaultRadiusMultiplier();
    let isDraggingAnySlider = false;

    // Header
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.marginBottom = "6px";

    const title = document.createElement("span");
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    title.textContent = "Goo Aura";

    const statusBadge = document.createElement("span");
    statusBadge.style.fontSize = "11px";
    statusBadge.style.color = "#9ca3af";
    statusBadge.textContent = "0 selected";

    headerRow.append(title, statusBadge);

    // --- GROUPS SECTION ---
    const groupHeaderRow = document.createElement("div");
    groupHeaderRow.style.display = "flex";
    groupHeaderRow.style.justifyContent = "space-between";
    groupHeaderRow.style.alignItems = "center";
    groupHeaderRow.style.marginBottom = "4px";

    const groupSectionLabel = document.createElement("span");
    groupSectionLabel.style.fontSize = "11px";
    groupSectionLabel.style.fontWeight = "600";
    groupSectionLabel.style.color = "#9ca3af";
    groupSectionLabel.textContent = "Target (Click to Switch)";

    const addGroupBtn = document.createElement("button");
    addGroupBtn.textContent = "+ Group";
    addGroupBtn.title = "Add another goo group";
    addGroupBtn.style.padding = "2px 7px";
    addGroupBtn.style.borderRadius = "5px";
    addGroupBtn.style.border = "1px solid #374151";
    addGroupBtn.style.background = "#272930";
    addGroupBtn.style.color = "#e5e7eb";
    addGroupBtn.style.fontSize = "10px";
    addGroupBtn.style.fontWeight = "600";
    addGroupBtn.style.cursor = "pointer";

    groupHeaderRow.append(groupSectionLabel, addGroupBtn);

    const groupList = document.createElement("div");
    groupList.className = "goo-scroll";
    groupList.style.display = "flex";
    groupList.style.flexDirection = "column";
    groupList.style.gap = "4px";
    groupList.style.maxHeight = "124px";
    groupList.style.overflowY = "auto";
    groupList.style.overflowX = "hidden";
    groupList.style.padding = "1px";
    groupList.style.marginBottom = "7px";

    // --- COLORS SECTION ---
    const colorSectionLabel = document.createElement("div");
    colorSectionLabel.style.fontSize = "11px";
    colorSectionLabel.style.fontWeight = "600";
    colorSectionLabel.style.color = "#9ca3af";
    colorSectionLabel.style.borderTop = "1px solid #2e3038";
    colorSectionLabel.style.paddingTop = "6px";
    colorSectionLabel.style.marginBottom = "4px";
    colorSectionLabel.textContent = "Apply Color to Target";

    const colorList = document.createElement("div");
    colorList.className = "goo-scroll";
    colorList.style.display = "flex";
    colorList.style.flexDirection = "column";
    colorList.style.gap = "4px";
    colorList.style.flex = "1";
    colorList.style.minHeight = "56px";
    colorList.style.overflowY = "auto";
    colorList.style.overflowX = "hidden";
    colorList.style.padding = "2px";
    colorList.style.marginBottom = "7px";

    // --- COLOR PROPERTIES & CUSTOM COLOR SECTION ---
    const colorPropsBox = document.createElement("div");
    colorPropsBox.style.padding = "6px 8px";
    colorPropsBox.style.marginBottom = "6px";
    colorPropsBox.style.borderRadius = "6px";
    colorPropsBox.style.background = "#141519";
    colorPropsBox.style.border = "1px solid #2e3038";
    colorPropsBox.style.display = "flex";
    colorPropsBox.style.flexDirection = "column";
    colorPropsBox.style.gap = "6px";

    const opacityCtrl = createCompactSlider(
      "Color Opacity",
      0,
      100,
      1,
      Math.round(activeOpacity * 100),
      (v) => `${Math.round(v)}%`
    );

    const rimCtrl = createCompactSlider(
      "Edge Highlight",
      0,
      100,
      1,
      Math.round(activeRim * 100),
      (v) => `${Math.round(v)}%`
    );

    const wobbleCtrl = createCompactSlider(
      "Organic Wobble",
      0,
      100,
      1,
      Math.round(activeWobble * 100),
      (v) => `${Math.round(v)}%`
    );

    // Custom Color Name + Picker + Hex + Save
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "New color name (e.g. Bile Yellow)";
    nameInput.style.width = "100%";
    nameInput.style.padding = "4px 8px";
    nameInput.style.borderRadius = "5px";
    nameInput.style.border = "1px solid #374151";
    nameInput.style.background = "#1e1f24";
    nameInput.style.color = "#f3f4f6";
    nameInput.style.fontSize = "11px";
    nameInput.style.outline = "none";

    const hexRow = document.createElement("div");
    hexRow.style.display = "flex";
    hexRow.style.gap = "6px";
    hexRow.style.alignItems = "center";

    const pickerInput = document.createElement("input");
    pickerInput.type = "color";
    pickerInput.value = activeHex;
    pickerInput.style.width = "26px";
    pickerInput.style.height = "24px";
    pickerInput.style.padding = "0";
    pickerInput.style.border = "1px solid #374151";
    pickerInput.style.borderRadius = "5px";
    pickerInput.style.background = "transparent";
    pickerInput.style.cursor = "pointer";

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.value = activeHex;
    hexInput.placeholder = "#06b6d4";
    hexInput.style.flex = "1";
    hexInput.style.minWidth = "0";
    hexInput.style.padding = "4px 7px";
    hexInput.style.borderRadius = "5px";
    hexInput.style.border = "1px solid #374151";
    hexInput.style.background = "#1e1f24";
    hexInput.style.color = "#f3f4f6";
    hexInput.style.fontSize = "11px";
    hexInput.style.fontFamily = "monospace";
    hexInput.style.outline = "none";

    nameInput.addEventListener("input", () => {
      if (nameInput.value.trim().length > 0) {
        editingColorId = null;
      }
    });

    pickerInput.addEventListener("input", () => {
      hexInput.value = pickerInput.value;
      hexInput.style.borderColor = "#374151";
      editingColorId = null;
      activeHex = pickerInput.value;
      rebuildSwatches();
    });

    hexInput.addEventListener("input", () => {
      const norm = normalizeRgbHex(hexInput.value);
      if (norm) {
        pickerInput.value = norm;
        hexInput.style.borderColor = "#374151";
        editingColorId = null;
        activeHex = norm;
        rebuildSwatches();
      }
    });

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.padding = "4px 10px";
    saveBtn.style.borderRadius = "5px";
    saveBtn.style.border = "none";
    saveBtn.style.background = "#3b82f6";
    saveBtn.style.color = "#ffffff";
    saveBtn.style.fontSize = "11px";
    saveBtn.style.fontWeight = "600";
    saveBtn.style.cursor = "pointer";

    hexRow.append(pickerInput, hexInput, saveBtn);
    colorPropsBox.append(
      opacityCtrl.row,
      rimCtrl.row,
      wobbleCtrl.row,
      nameInput,
      hexRow
    );

    // --- TARGET AURA RADIUS & HIDDEN TOGGLE ---
    const targetPropsBox = document.createElement("div");
    targetPropsBox.style.padding = "6px 8px";
    targetPropsBox.style.marginBottom = "7px";
    targetPropsBox.style.borderRadius = "6px";
    targetPropsBox.style.background = "#141519";
    targetPropsBox.style.border = "1px solid #2e3038";
    targetPropsBox.style.display = "flex";
    targetPropsBox.style.flexDirection = "column";
    targetPropsBox.style.gap = "6px";

    const radiusCtrl = createCompactSlider(
      "Aura Radius (Size-Scaled)",
      MIN_RADIUS_MULTIPLIER,
      MAX_RADIUS_MULTIPLIER,
      0.05,
      selectionRadiusMultiplier,
      (v) => `${v.toFixed(2)} sq`
    );

    const hiddenToggleRow = document.createElement("label");
    hiddenToggleRow.style.display = "flex";
    hiddenToggleRow.style.alignItems = "center";
    hiddenToggleRow.style.justifyContent = "space-between";
    hiddenToggleRow.style.gap = "8px";
    hiddenToggleRow.style.cursor = "pointer";

    const hiddenToggleText = document.createElement("span");
    hiddenToggleText.style.fontSize = "10.5px";
    hiddenToggleText.style.color = "#d1d5db";
    hiddenToggleText.textContent = "Keep goo when token is hidden";

    const hiddenCheckbox = document.createElement("input");
    hiddenCheckbox.type = "checkbox";
    hiddenCheckbox.style.accentColor = "#3b82f6";
    hiddenCheckbox.style.cursor = "pointer";
    hiddenCheckbox.style.margin = "0";

    hiddenToggleRow.append(hiddenToggleText, hiddenCheckbox);
    targetPropsBox.append(radiusCtrl.row, hiddenToggleRow);

    // --- REMOVE / HIDE GOO BUTTON ---
    const removeBtn = document.createElement("button");
    removeBtn.style.width = "100%";
    removeBtn.style.padding = "6px 10px";
    removeBtn.style.borderRadius = "6px";
    removeBtn.style.border = "1px solid #4b5563";
    removeBtn.style.background = "#272930";
    removeBtn.style.color = "#f87171";
    removeBtn.style.fontSize = "11px";
    removeBtn.style.fontWeight = "600";
    removeBtn.style.cursor = "pointer";

    window.addEventListener("pointerup", () => {
      isDraggingAnySlider = false;
    });

    function syncEditorInputs(
      hex: string,
      opacity: number,
      rim: number,
      wobble: number
    ) {
      activeHex = hex;
      activeOpacity = clampUnit(opacity, DEFAULT_OPACITY);
      activeRim = clampUnit(rim, DEFAULT_RIM);
      activeWobble = clampUnit(wobble, DEFAULT_WOBBLE);

      pickerInput.value = hex;
      hexInput.value = hex;

      const opPct = Math.round(activeOpacity * 100);
      opacityCtrl.slider.value = String(opPct);
      opacityCtrl.valueTag.textContent = `${opPct}%`;

      const rimPct = Math.round(activeRim * 100);
      rimCtrl.slider.value = String(rimPct);
      rimCtrl.valueTag.textContent = `${rimPct}%`;

      const wobPct = Math.round(activeWobble * 100);
      wobbleCtrl.slider.value = String(wobPct);
      wobbleCtrl.valueTag.textContent = `${wobPct}%`;
    }

    function updateFooterControls() {
      if (activeTarget === "selection") {
        removeBtn.textContent = "Remove Goo from Selected";
        colorSectionLabel.textContent = "Apply Color to Selected Tokens";
        hiddenCheckbox.checked = selectionKeepWhenHidden;
        if (!isDraggingAnySlider) {
          radiusCtrl.slider.value = String(selectionRadiusMultiplier);
          radiusCtrl.valueTag.textContent = `${selectionRadiusMultiplier.toFixed(2)} sq`;
        }
      } else {
        const grp = getSavedGroups().find((g) => g.id === activeTarget);
        const label = grp ? grp.name : "Group";
        const rad = grp?.radiusMultiplier ?? DEFAULT_RADIUS_MULTIPLIER;
        removeBtn.textContent = `Turn Off Goo for "${label}"`;
        colorSectionLabel.textContent = `Apply Color to "${label}"`;
        hiddenCheckbox.checked = Boolean(grp?.keepWhenHidden);
        if (!isDraggingAnySlider) {
          radiusCtrl.slider.value = String(rad);
          radiusCtrl.valueTag.textContent = `${rad.toFixed(2)} sq`;
        }
      }
    }

    function setActiveTarget(target: string) {
      activeTarget = target;
      setStoredActiveTarget(target);

      if (target !== "selection") {
        const grp = getSavedGroups().find((g) => g.id === target);
        if (grp) {
          const parsed = parseRgbaHex(grp.rgbaHex);
          syncEditorInputs(parsed.hex, parsed.opacity, grp.rim, grp.wobble);
          setDefaultStyle({
            rgbaHex: grp.rgbaHex,
            rim: grp.rim,
            wobble: grp.wobble,
          });
          setDefaultRadiusMultiplier(grp.radiusMultiplier);
          const matchingPreset = getSavedColors().find(
            (c) =>
              c.hex === parsed.hex &&
              Math.abs(c.opacity - parsed.opacity) < 0.02
          );
          editingColorId = matchingPreset?.id ?? null;
        }
      }

      updateFooterControls();
      updateGroupRowHighlights();
      rebuildSwatches();
    }

    const groupRowElements = new Map<string, HTMLDivElement>();

    function updateGroupRowHighlights() {
      groupRowElements.forEach((el, id) => {
        const isActive = id === activeTarget;
        el.style.borderColor = isActive ? "#3b82f6" : "#2e3038";
        el.style.background = isActive ? "#262b38" : "#141519";
      });
    }

    async function applyStyleToTarget(
      rgbaHex: string,
      rim: number,
      wobble: number
    ) {
      if ((await OBR.player.getRole()) !== "GM") return;

      if (activeTarget === "selection") {
        const selection = await OBR.player.getSelection();
        if (!selection || selection.length === 0) return;

        await OBR.scene.items.updateItems(selection, (items) => {
          for (const item of items) {
            if (isImage(item) && item.layer === "CHARACTER") {
              item.metadata[META_KEY] = true;
              item.metadata[COLOR_META_KEY] = rgbaHex;
              item.metadata[RIM_META_KEY] = rim;
              item.metadata[WOBBLE_META_KEY] = wobble;
              if (typeof item.metadata[RADIUS_META_KEY] !== "number") {
                item.metadata[RADIUS_META_KEY] = selectionRadiusMultiplier;
              }
            }
          }
        });
      } else {
        const groups = getSavedGroups();
        const targetGroup = groups.find((g) => g.id === activeTarget);
        if (targetGroup) {
          targetGroup.rgbaHex = rgbaHex;
          targetGroup.rim = rim;
          targetGroup.wobble = wobble;
          saveGroups(groups);
        }

        const allItems = await OBR.scene.items.getItems();
        const groupTokenIds = allItems
          .filter(
            (item) =>
              isImage(item) && item.metadata[GROUP_META_KEY] === activeTarget
          )
          .map((item) => item.id);

        if (groupTokenIds.length > 0) {
          await OBR.scene.items.updateItems(groupTokenIds, (items) => {
            for (const item of items) {
              item.metadata[META_KEY] = true;
              item.metadata[COLOR_META_KEY] = rgbaHex;
              item.metadata[RIM_META_KEY] = rim;
              item.metadata[WOBBLE_META_KEY] = wobble;
              item.metadata[RADIUS_META_KEY] =
                targetGroup?.radiusMultiplier ?? DEFAULT_RADIUS_MULTIPLIER;
              if (targetGroup?.keepWhenHidden) {
                item.metadata[KEEP_WHEN_HIDDEN_META_KEY] = true;
              } else {
                delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
              }
            }
          });
        }

        rebuildGroups();
      }
    }

    function bindThrottledSlider(
      sliderEl: HTMLInputElement,
      tagEl: HTMLSpanElement,
      formatFn: (v: number) => string,
      onCommit: (v: number) => void
    ) {
      let lastPush = 0;
      let timer: number | undefined;

      sliderEl.addEventListener("pointerdown", () => {
        isDraggingAnySlider = true;
      });

      sliderEl.addEventListener("input", () => {
        const val = Number(sliderEl.value);
        tagEl.textContent = formatFn(val);

        const now = Date.now();
        if (now - lastPush >= 45) {
          lastPush = now;
          onCommit(val);
        } else {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            lastPush = Date.now();
            onCommit(val);
          }, 45);
        }
      });

      sliderEl.addEventListener("change", () => {
        isDraggingAnySlider = false;
        window.clearTimeout(timer);
        onCommit(Number(sliderEl.value));
      });
    }

    // 1. Color Opacity Slider
    bindThrottledSlider(
      opacityCtrl.slider,
      opacityCtrl.valueTag,
      (v) => `${Math.round(v)}%`,
      async (pct) => {
        const nextOpacity = clampUnit(pct / 100, DEFAULT_OPACITY);
        activeOpacity = nextOpacity;
        const rgbaHex = formatRgbaHex(activeHex, nextOpacity);
        setDefaultStyle({ rgbaHex });

        if (editingColorId) {
          const allColors = getSavedColors();
          const targetColor = allColors.find((c) => c.id === editingColorId);
          if (targetColor) {
            if (targetColor.builtIn) {
              saveBuiltInOverride(targetColor.id, { opacity: nextOpacity });
            } else {
              targetColor.opacity = nextOpacity;
              saveCustomColors(allColors);
            }
            rebuildSwatches();
          }
        }

        await applyStyleToTarget(rgbaHex, activeRim, activeWobble);
      }
    );

    // 2. Edge Highlight Slider (per color)
    bindThrottledSlider(
      rimCtrl.slider,
      rimCtrl.valueTag,
      (v) => `${Math.round(v)}%`,
      async (pct) => {
        const nextRim = clampUnit(pct / 100, DEFAULT_RIM);
        activeRim = nextRim;
        const rgbaHex = formatRgbaHex(activeHex, activeOpacity);
        setDefaultStyle({ rim: nextRim });

        if (editingColorId) {
          const allColors = getSavedColors();
          const targetColor = allColors.find((c) => c.id === editingColorId);
          if (targetColor) {
            if (targetColor.builtIn) {
              saveBuiltInOverride(targetColor.id, { rim: nextRim });
            } else {
              targetColor.rim = nextRim;
              saveCustomColors(allColors);
            }
            rebuildSwatches();
          }
        }

        await applyStyleToTarget(rgbaHex, nextRim, activeWobble);
      }
    );

    // 3. Organic Wobble Slider (per color AND per token/group)
    bindThrottledSlider(
      wobbleCtrl.slider,
      wobbleCtrl.valueTag,
      (v) => `${Math.round(v)}%`,
      async (pct) => {
        const nextWobble = clampUnit(pct / 100, DEFAULT_WOBBLE);
        activeWobble = nextWobble;
        setDefaultStyle({ wobble: nextWobble });

        if (editingColorId) {
          const allColors = getSavedColors();
          const targetColor = allColors.find((c) => c.id === editingColorId);
          if (targetColor) {
            if (targetColor.builtIn) {
              saveBuiltInOverride(targetColor.id, { wobble: nextWobble });
            } else {
              targetColor.wobble = nextWobble;
              saveCustomColors(allColors);
            }
            rebuildSwatches();
          }
        }

        if ((await OBR.player.getRole()) !== "GM") return;

        // Apply wobble directly to the active target (without overwriting other token properties)
        if (activeTarget === "selection") {
          const selection = await OBR.player.getSelection();
          if (!selection || selection.length === 0) return;

          await OBR.scene.items.updateItems(selection, (items) => {
            for (const item of items) {
              if (isImage(item) && item.layer === "CHARACTER") {
                item.metadata[WOBBLE_META_KEY] = nextWobble;
              }
            }
          });
        } else {
          const groups = getSavedGroups();
          const targetGroup = groups.find((g) => g.id === activeTarget);
          if (targetGroup) {
            targetGroup.wobble = nextWobble;
            saveGroups(groups);
          }

          const allItems = await OBR.scene.items.getItems();
          const groupTokenIds = allItems
            .filter(
              (item) =>
                isImage(item) && item.metadata[GROUP_META_KEY] === activeTarget
            )
            .map((item) => item.id);

          if (groupTokenIds.length > 0) {
            await OBR.scene.items.updateItems(groupTokenIds, (items) => {
              for (const item of items) {
                item.metadata[WOBBLE_META_KEY] = nextWobble;
              }
            });
          }
        }
      }
    );

    // 4. Aura Radius Slider
    bindThrottledSlider(
      radiusCtrl.slider,
      radiusCtrl.valueTag,
      (v) => `${v.toFixed(2)} sq`,
      async (val) => {
        if ((await OBR.player.getRole()) !== "GM") return;
        const clamped = clampRadiusMultiplier(val);
        setDefaultRadiusMultiplier(clamped);

        if (activeTarget === "selection") {
          selectionRadiusMultiplier = clamped;
          const selection = await OBR.player.getSelection();
          if (!selection || selection.length === 0) return;

          await OBR.scene.items.updateItems(selection, (items) => {
            for (const item of items) {
              if (isImage(item) && item.layer === "CHARACTER") {
                item.metadata[RADIUS_META_KEY] = clamped;
              }
            }
          });
        } else {
          const groups = getSavedGroups();
          const targetGroup = groups.find((g) => g.id === activeTarget);
          if (targetGroup) {
            targetGroup.radiusMultiplier = clamped;
            saveGroups(groups);
          }

          const allItems = await OBR.scene.items.getItems();
          const groupTokenIds = allItems
            .filter(
              (item) =>
                isImage(item) && item.metadata[GROUP_META_KEY] === activeTarget
            )
            .map((item) => item.id);

          if (groupTokenIds.length > 0) {
            await OBR.scene.items.updateItems(groupTokenIds, (items) => {
              for (const item of items) {
                item.metadata[RADIUS_META_KEY] = clamped;
              }
            });
          }
        }
      }
    );

    hiddenCheckbox.addEventListener("change", async () => {
      if ((await OBR.player.getRole()) !== "GM") return;
      const keep = hiddenCheckbox.checked;

      if (activeTarget === "selection") {
        selectionKeepWhenHidden = keep;
        const selection = await OBR.player.getSelection();
        if (!selection || selection.length === 0) return;

        await OBR.scene.items.updateItems(selection, (items) => {
          for (const item of items) {
            if (isImage(item) && item.layer === "CHARACTER") {
              if (keep) {
                item.metadata[KEEP_WHEN_HIDDEN_META_KEY] = true;
              } else {
                delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
              }
            }
          }
        });
      } else {
        const groups = getSavedGroups();
        const targetGroup = groups.find((g) => g.id === activeTarget);
        if (targetGroup) {
          targetGroup.keepWhenHidden = keep;
          saveGroups(groups);
        }

        const allItems = await OBR.scene.items.getItems();
        const groupTokenIds = allItems
          .filter(
            (item) =>
              isImage(item) && item.metadata[GROUP_META_KEY] === activeTarget
          )
          .map((item) => item.id);

        if (groupTokenIds.length > 0) {
          await OBR.scene.items.updateItems(groupTokenIds, (items) => {
            for (const item of items) {
              if (keep) {
                item.metadata[KEEP_WHEN_HIDDEN_META_KEY] = true;
              } else {
                delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
              }
            }
          });
        }
      }
    });

    async function assignSelectionToGroup(group: SavedGooGroup) {
      if ((await OBR.player.getRole()) !== "GM") return;

      const selection = await OBR.player.getSelection();
      if (!selection || selection.length === 0) return;

      await OBR.scene.items.updateItems(selection, (items) => {
        for (const item of items) {
          if (isImage(item) && item.layer === "CHARACTER") {
            item.metadata[GROUP_META_KEY] = group.id;
            item.metadata[META_KEY] = true;
            item.metadata[COLOR_META_KEY] = group.rgbaHex;
            item.metadata[RIM_META_KEY] = group.rim;
            item.metadata[WOBBLE_META_KEY] = group.wobble;
            item.metadata[RADIUS_META_KEY] = group.radiusMultiplier;
            if (group.keepWhenHidden) {
              item.metadata[KEEP_WHEN_HIDDEN_META_KEY] = true;
            } else {
              delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
            }
          }
        }
      });

      setActiveTarget(group.id);
      await refreshCounts();
    }

    function rebuildGroups() {
      const groups = getSavedGroups();
      if (
        activeTarget !== "selection" &&
        !groups.some((g) => g.id === activeTarget)
      ) {
        activeTarget = groups[0]?.id ?? "selection";
        setStoredActiveTarget(activeTarget);
      }

      groupRowElements.clear();
      groupList.replaceChildren();

      // 1. "Map Selection" target option
      const selRow = document.createElement("div");
      selRow.style.display = "flex";
      selRow.style.alignItems = "center";
      selRow.style.justifyContent = "space-between";
      selRow.style.padding = "4px 8px";
      selRow.style.borderRadius = "6px";
      selRow.style.border = "1px solid #2e3038";
      selRow.style.cursor = "pointer";
      selRow.style.flexShrink = "0";

      const selTitle = document.createElement("span");
      selTitle.style.fontSize = "11px";
      selTitle.style.fontWeight = "600";
      selTitle.style.color = "#d1d5db";
      selTitle.textContent = "Map Selection";

      const selCountTag = document.createElement("span");
      selCountTag.style.fontSize = "10px";
      selCountTag.style.color = "#9ca3af";
      selCountTag.textContent = `${selectedCount} selected`;

      selRow.append(selTitle, selCountTag);
      selRow.addEventListener("click", () => setActiveTarget("selection"));

      groupRowElements.set("selection", selRow);
      groupList.appendChild(selRow);

      // 2. Saved Goo Groups
      groups.forEach((group) => {
        const parsedColor = parseRgbaHex(group.rgbaHex);
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "5px";
        row.style.padding = "3px 6px";
        row.style.borderRadius = "6px";
        row.style.border = "1px solid #2e3038";
        row.style.cursor = "pointer";
        row.style.flexShrink = "0";

        const colorDot = document.createElement("span");
        colorDot.style.width = "10px";
        colorDot.style.height = "10px";
        colorDot.style.borderRadius = "50%";
        colorDot.style.background = parsedColor.hex;
        colorDot.style.opacity = String(Math.max(0.25, parsedColor.opacity));
        colorDot.style.flexShrink = "0";
        colorDot.style.border = "1px solid rgba(255,255,255,0.45)";

        const groupNameInput = document.createElement("input");
        groupNameInput.type = "text";
        groupNameInput.className = "goo-group-name-input";
        groupNameInput.value = group.name;
        groupNameInput.title = "Click to rename group";

        groupNameInput.addEventListener("click", (e) => {
          e.stopPropagation();
          if (activeTarget !== group.id) {
            setActiveTarget(group.id);
          }
        });

        const commitGroupName = () => {
          const trimmed = groupNameInput.value.trim();
          const currentGroups = getSavedGroups();
          const target = currentGroups.find((g) => g.id === group.id);
          if (!target) return;

          if (!trimmed) {
            groupNameInput.value = target.name;
            return;
          }
          if (target.name !== trimmed) {
            target.name = trimmed;
            saveGroups(currentGroups);
            updateFooterControls();
          }
        };

        groupNameInput.addEventListener("blur", commitGroupName);
        groupNameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            groupNameInput.blur();
          }
        });

        const countBadge = document.createElement("span");
        const count = groupCounts[group.id] ?? 0;
        countBadge.textContent = String(count);
        countBadge.title = `${count} token${count === 1 ? "" : "s"} in group`;
        countBadge.style.fontSize = "10px";
        countBadge.style.fontWeight = "600";
        countBadge.style.color = count > 0 ? "#e5e7eb" : "#6b7280";
        countBadge.style.background = "#1e1f24";
        countBadge.style.padding = "1px 5px";
        countBadge.style.borderRadius = "999px";
        countBadge.style.flexShrink = "0";

        const assignBtn = document.createElement("button");
        assignBtn.textContent = "+Assign";
        assignBtn.title = `Assign selected map tokens to ${group.name}`;
        assignBtn.style.padding = "2px 5px";
        assignBtn.style.borderRadius = "4px";
        assignBtn.style.border = "1px solid #374151";
        assignBtn.style.background = "#272930";
        assignBtn.style.color = "#93c5fd";
        assignBtn.style.fontSize = "10px";
        assignBtn.style.fontWeight = "600";
        assignBtn.style.cursor = "pointer";
        assignBtn.style.flexShrink = "0";

        assignBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await assignSelectionToGroup(group);
        });

        const selectBtn = document.createElement("button");
        selectBtn.textContent = "Sel";
        selectBtn.title = `Select all ${group.name} tokens on the map`;
        selectBtn.style.padding = "2px 5px";
        selectBtn.style.borderRadius = "4px";
        selectBtn.style.border = "1px solid #374151";
        selectBtn.style.background = "#272930";
        selectBtn.style.color = "#d1d5db";
        selectBtn.style.fontSize = "10px";
        selectBtn.style.cursor = "pointer";
        selectBtn.style.flexShrink = "0";

        selectBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          setActiveTarget(group.id);
          const allItems = await OBR.scene.items.getItems();
          const ids = allItems
            .filter(
              (item) =>
                isImage(item) && item.metadata[GROUP_META_KEY] === group.id
            )
            .map((item) => item.id);
          await OBR.player.select(ids);
        });

        row.append(colorDot, groupNameInput, countBadge, assignBtn, selectBtn);

        if (!group.builtIn) {
          const delGroupBtn = document.createElement("button");
          delGroupBtn.textContent = "×";
          delGroupBtn.title = "Delete group";
          delGroupBtn.style.padding = "1px 4px";
          delGroupBtn.style.borderRadius = "4px";
          delGroupBtn.style.border = "none";
          delGroupBtn.style.background = "transparent";
          delGroupBtn.style.color = "#9ca3af";
          delGroupBtn.style.fontSize = "12px";
          delGroupBtn.style.cursor = "pointer";
          delGroupBtn.style.flexShrink = "0";

          delGroupBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const remaining = getSavedGroups().filter((g) => g.id !== group.id);
            saveGroups(remaining);
            if (activeTarget === group.id) {
              setActiveTarget(remaining[0]?.id ?? "selection");
            }
            rebuildGroups();
          });

          row.appendChild(delGroupBtn);
        }

        row.addEventListener("click", () => setActiveTarget(group.id));

        groupRowElements.set(group.id, row);
        groupList.appendChild(row);
      });

      updateGroupRowHighlights();
      updateFooterControls();
    }

    addGroupBtn.addEventListener("click", () => {
      const current = getSavedGroups();
      const nextNum = current.length + 1;
      const newGroup: SavedGooGroup = {
        id: `group-${Date.now()}`,
        name: `Group ${nextNum}`,
        rgbaHex: formatRgbaHex(activeHex, activeOpacity),
        rim: activeRim,
        wobble: activeWobble,
        radiusMultiplier: getDefaultRadiusMultiplier(),
        keepWhenHidden: false,
      };
      saveGroups([...current, newGroup]);
      setActiveTarget(newGroup.id);
      rebuildGroups();
      groupList.scrollTop = groupList.scrollHeight;
    });

    function rebuildSwatches() {
      const colors = getSavedColors();
      colorList.replaceChildren();

      colors.forEach((preset) => {
        const opPct = Math.round(preset.opacity * 100);
        const isSelected =
          editingColorId === preset.id ||
          (editingColorId === null && preset.hex === activeHex);

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        row.style.width = "100%";
        row.style.flexShrink = "0";

        const btn = document.createElement("button");
        btn.title = `${preset.name} (${preset.hex} · ${opPct}% opacity · ${Math.round(preset.rim * 100)}% edge · ${Math.round(preset.wobble * 100)}% wobble)`;
        btn.style.flex = "1";
        btn.style.minWidth = "0";
        btn.style.height = "26px";
        btn.style.borderRadius = "6px";
        btn.style.border = "none";
        btn.style.background = preset.hex;
        btn.style.cursor = "pointer";
        btn.style.padding = "0 9px";
        btn.style.display = "flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "space-between";
        btn.style.gap = "6px";
        btn.style.outline = isSelected
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

        const metaTag = document.createElement("span");
        metaTag.style.fontSize = "9.5px";
        metaTag.style.fontFamily = "monospace";
        metaTag.style.color = "rgba(255,255,255,0.92)";
        metaTag.style.textShadow = "0 1px 2px rgba(0,0,0,0.8)";
        metaTag.style.flexShrink = "0";
        metaTag.textContent = `${preset.hex.toUpperCase()} · ${opPct}%`;

        btn.append(nameLabel, metaTag);

        btn.addEventListener("click", async () => {
          editingColorId = preset.id;
          nameInput.value = "";
          syncEditorInputs(preset.hex, preset.opacity, preset.rim, preset.wobble);
          const rgbaHex = formatRgbaHex(preset.hex, preset.opacity);
          setDefaultStyle({
            rgbaHex,
            rim: preset.rim,
            wobble: preset.wobble,
          });
          rebuildSwatches();
          await applyStyleToTarget(rgbaHex, preset.rim, preset.wobble);
        });

        row.appendChild(btn);

        if (!preset.builtIn) {
          const delBtn = document.createElement("button");
          delBtn.title = "Delete saved color";
          delBtn.textContent = "×";
          delBtn.style.width = "24px";
          delBtn.style.height = "26px";
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
            if (editingColorId === preset.id) {
              const fallback = STARTING_COLORS[0];
              editingColorId = fallback.id;
              syncEditorInputs(
                fallback.hex,
                fallback.opacity,
                fallback.rim,
                fallback.wobble
              );
              setDefaultStyle({
                rgbaHex: formatRgbaHex(fallback.hex, fallback.opacity),
                rim: fallback.rim,
                wobble: fallback.wobble,
              });
            }
            rebuildSwatches();
          });

          row.appendChild(delBtn);
        }

        colorList.appendChild(row);
      });
    }

    saveBtn.addEventListener("click", async () => {
      if ((await OBR.player.getRole()) !== "GM") return;

      const norm = normalizeRgbHex(hexInput.value);
      if (!norm) {
        hexInput.style.borderColor = "#ef4444";
        return;
      }

      const customName = nameInput.value.trim() || norm.toUpperCase();
      const existingCustom = getSavedColors().filter((c) => !c.builtIn);
      const newId = `custom-${Date.now()}`;
      const newEntry: SavedGooColor = {
        id: newId,
        name: customName,
        hex: norm,
        opacity: activeOpacity,
        rim: activeRim,
        wobble: activeWobble,
      };

      saveCustomColors([...existingCustom, newEntry]);
      nameInput.value = "";
      editingColorId = newId;
      syncEditorInputs(norm, activeOpacity, activeRim, activeWobble);
      const rgbaHex = formatRgbaHex(norm, activeOpacity);
      setDefaultStyle({ rgbaHex, rim: activeRim, wobble: activeWobble });
      rebuildSwatches();
      colorList.scrollTop = colorList.scrollHeight;
      await applyStyleToTarget(rgbaHex, activeRim, activeWobble);
    });

    removeBtn.addEventListener("click", async () => {
      if ((await OBR.player.getRole()) !== "GM") return;

      if (activeTarget === "selection") {
        const selection = await OBR.player.getSelection();
        if (!selection || selection.length === 0) return;

        await OBR.scene.items.updateItems(selection, (items) => {
          for (const item of items) {
            delete item.metadata[META_KEY];
            delete item.metadata[COLOR_META_KEY];
            delete item.metadata[RIM_META_KEY];
            delete item.metadata[WOBBLE_META_KEY];
            delete item.metadata[RADIUS_META_KEY];
            delete item.metadata[GROUP_META_KEY];
            delete item.metadata[KEEP_WHEN_HIDDEN_META_KEY];
          }
        });
      } else {
        const allItems = await OBR.scene.items.getItems();
        const groupTokenIds = allItems
          .filter(
            (item) =>
              isImage(item) && item.metadata[GROUP_META_KEY] === activeTarget
          )
          .map((item) => item.id);

        if (groupTokenIds.length > 0) {
          await OBR.scene.items.updateItems(groupTokenIds, (items) => {
            for (const item of items) {
              delete item.metadata[META_KEY];
            }
          });
        }
      }
    });

    const refreshCounts = async () => {
      const [selection, sceneReady] = await Promise.all([
        OBR.player.getSelection(),
        OBR.scene.isReady(),
      ]);

      const selectedIds = selection ?? [];
      selectedCount = selectedIds.length;
      statusBadge.textContent = `${selectedCount} selected`;

      if (sceneReady) {
        const items = await OBR.scene.items.getItems();
        const counts: Record<string, number> = {};
        let anySelectedKeep = false;
        let foundSelectedRadius: number | null = null;
        let foundSelectedWobble: number | null = null;

        for (const item of items) {
          if (isImage(item)) {
            const gid = item.metadata[GROUP_META_KEY];
            if (typeof gid === "string") {
              counts[gid] = (counts[gid] ?? 0) + 1;
            }
            if (selectedIds.includes(item.id)) {
              if (item.metadata[KEEP_WHEN_HIDDEN_META_KEY]) {
                anySelectedKeep = true;
              }
              if (
                foundSelectedRadius === null &&
                typeof item.metadata[RADIUS_META_KEY] === "number"
              ) {
                foundSelectedRadius = clampRadiusMultiplier(
                  item.metadata[RADIUS_META_KEY]
                );
              }
              if (
                foundSelectedWobble === null &&
                typeof item.metadata[WOBBLE_META_KEY] === "number"
              ) {
                foundSelectedWobble = clampUnit(
                  item.metadata[WOBBLE_META_KEY],
                  DEFAULT_WOBBLE
                );
              }
            }
          }
        }
        groupCounts = counts;
        selectionKeepWhenHidden = anySelectedKeep;
        if (foundSelectedRadius !== null) {
          selectionRadiusMultiplier = foundSelectedRadius;
        }
        if (
          activeTarget === "selection" &&
          foundSelectedWobble !== null &&
          !isDraggingAnySlider
        ) {
          activeWobble = foundSelectedWobble;
          const wobPct = Math.round(activeWobble * 100);
          wobbleCtrl.slider.value = String(wobPct);
          wobbleCtrl.valueTag.textContent = `${wobPct}%`;
        }
      }

      if (
        !document.activeElement ||
        !document.activeElement.classList.contains("goo-group-name-input")
      ) {
        rebuildGroups();
      } else {
        updateFooterControls();
      }
    };

    refreshCounts();
    rebuildSwatches();
    container.append(
      headerRow,
      groupHeaderRow,
      groupList,
      colorSectionLabel,
      colorList,
      colorPropsBox,
      targetPropsBox,
      removeBtn
    );
    document.body.replaceChildren(container);
    return refreshCounts;
  }

  let refreshFn =
    currentRole === "GM" ? renderGmEditorView() : (renderLockedPlayerView(), null);

  OBR.player.onChange((player) => {
    if (player.role !== currentRole) {
      currentRole = player.role;
      refreshFn =
        currentRole === "GM"
          ? renderGmEditorView()
          : (renderLockedPlayerView(), null);
    } else if (refreshFn) {
      refreshFn();
    }
  });

  OBR.scene.items.onChange(() => {
    if (refreshFn) {
      refreshFn();
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