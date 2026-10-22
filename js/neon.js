// ============================================================================
// WebGL2 Fluid Simulation for Steam Millennium
// Stable Fluids (Jos Stam) · OffscreenCanvas + Blob Worker
// Main Thread: DOM, events, bridge | Worker: WebGL, shaders, FBO, sim loop
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // КОНФИГУРАЦИЯ
    // ========================================================================
    const CONFIG = {
        TARGET_SELECTORS: [
            '._2gSXCB6PbOlMxslr8hm6dm',
            '[class*="libraryhome_Container"]',
            '[class*="library_LibraryHome"]',
            '[class*="library_Main"]',
        ],

        SIM_RESOLUTION: 64,
        DYE_RESOLUTION: 512,
        MAX_DPR: 1.5,
        VELOCITY_DISSIPATION: 0.975,
        DENSITY_DISSIPATION: 0.985,
        PRESSURE_ITERATIONS: 8,
        PRESSURE_DECAY: 0.92,
        CURL_STRENGTH: 32.0,
        VISCOSITY: 0.0,
        SPLAT_RADIUS: 0.0055,
        SPLAT_FORCE: 7000.0,

        MOUSE_MIN_DELTA: 0.0015,
        MOUSE_MAX_DELTA: 0.25,

        WINDOW_POLL_INTERVAL: 50,
        WINDOW_SMOOTH: 0.35,
        WINDOW_MIN_SPEED: 0.6,
        WINDOW_FORCE_MULTIPLIER: 55.0,
        WINDOW_SPEED_DIVISOR: 6,
        WINDOW_MAX_SPLATS: 2,
        WINDOW_TELEPORT_PX: 400,

        IDLE_SPLAT_INTERVAL: 2600,
        IDLE_SPLAT_FORCE: 900.0,

        TARGET_FPS: 60,
        RESIZE_DEBOUNCE: 300,
        DESTROY_GRACE_MS: 50,
        RECT_REFRESH_INTERVAL: 1500,

        POLL_MIN: 150,
        POLL_MAX: 2500,
        POLL_HEALTHCHECK: 3000,
    };

    // ========================================================================
    // УТИЛИТЫ ГЛАВНОГО ПОТОКА
    // ========================================================================
    function clamp(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function findTarget() {
        for (let i = 0; i < CONFIG.TARGET_SELECTORS.length; i++) {
            const el = document.querySelector(CONFIG.TARGET_SELECTORS[i]);
            if (el &&
                el.clientWidth >= 8 &&
                el.clientHeight >= 8 &&
                !el.querySelector('#fluid-sim-canvas')) {
                return el;
            }
        }
        return null;
    }

    // ========================================================================
    // CSS
    // ========================================================================
    function injectStyles() {
        if (document.getElementById('fluid-steam-override')) return;
        const style = document.createElement('style');
        style.id = 'fluid-steam-override';

        const bgRules = CONFIG.TARGET_SELECTORS.map((s) => `
            ${s} {
                background: transparent !important;
                background-color: transparent !important;
                background-image: none !important;
                isolation: isolate;
            }
            ${s} > div,
            ${s} [class*="library_LibraryHome"],
            ${s} [class*="library_Main"],
            ${s} [class*="libraryhome_Container"],
            ${s} [class*="libraryhome_UpdatesContainer"],
            ${s} [class*="gamelistbar_"],
            ${s} [class*="basicappdetailssection_"] {
                background: transparent !important;
                background-color: transparent !important;
            }
        `).join('\n');

        style.textContent = bgRules + `
            #fluid-sim-canvas {
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: 100% !important;
                z-index: -1 !important;
                pointer-events: none !important;
                display: block !important;
                will-change: transform;
                transform: translateZ(0);
                backface-visibility: hidden;
                contain: strict;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ========================================================================
    // WORKER SOURCE (Blob)
    // ========================================================================
    function getWorkerSource() {
        return `
'use strict';

let canvas = null;
let gl = null;
let ext = null;
let programs = {};
let activeProgram = null;

let vao = null;
let quadBuffer = null;
let indexBuffer = null;

let ready = false;
let contextLost = false;
let destroyed = false;
let rafScheduled = false;
let firstInitDone = false;
let advNeedsDyeTexel = true;
let lastTime = 0;
let lastIdleSplat = 0;
let CONFIG = null;
let FRAME_INTERVAL = 16.667;

let cssWidth = 0, cssHeight = 0;
let simW = 0, simH = 0, dyeW = 0, dyeH = 0;

let velocity = null, dye = null, pressure = null;
let divergenceFBO = null, curlFBO = null;

let mouseNX = 0, mouseNY = 0;
let mousePrevNX = -1, mousePrevNY = -1;
let mouseInside = false;

let windowDeltaX = 0, windowDeltaY = 0;
let winVelX = 0, winVelY = 0;

const _color = { r: 0, g: 0, b: 0 };

const SLOT_VELOCITY = 0;
const SLOT_SOURCE   = 1;
const SLOT_EXTRA    = 2;

// ─── Кэш привязок текстур: slot -> WebGLTexture ───
const boundTex = [null, null, null];

function bindTex(slot, texture) {
    if (boundTex[slot] !== texture) {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        boundTex[slot] = texture;
    }
    return slot;
}

// Сбрасываем ТОЛЬКО когда текстуры реально удаляются/инвалидируются.
// В swap() не нужен: меняются роли read/write, сами GL-объекты те же.
function resetTexCache() {
    boundTex[0] = null; boundTex[1] = null; boundTex[2] = null;
}

// ═══════════════════════════════════════════
// УТИЛИТЫ
// ═══════════════════════════════════════════

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function correctRadius(radius, aspectRatio) {
    return aspectRatio > 1 ? radius * aspectRatio : radius;
}

// zero-alloc: пишет результат в общий объект _color
function fillColorHSV(h, s, v, scale) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    const k = 0.6 * scale;
    switch (i % 6) {
        case 0: _color.r = v*k; _color.g = t*k; _color.b = p*k; break;
        case 1: _color.r = q*k; _color.g = v*k; _color.b = p*k; break;
        case 2: _color.r = p*k; _color.g = v*k; _color.b = t*k; break;
        case 3: _color.r = p*k; _color.g = q*k; _color.b = v*k; break;
        case 4: _color.r = t*k; _color.g = p*k; _color.b = v*k; break;
        default: _color.r = v*k; _color.g = p*k; _color.b = q*k; break;
    }
}

function glAlive() {
    return gl && !gl.isContextLost();
}

// ═══════════════════════════════════════════
// ШЕЙДЕРЫ
// ═══════════════════════════════════════════

const SHADERS = {
    baseVertex: \`
        precision highp float;
        attribute vec2 aPosition;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform vec2 texelSize;
        void main () {
            vUv = aPosition * 0.5 + 0.5;
            vL = vUv - vec2(texelSize.x, 0.0);
            vR = vUv + vec2(texelSize.x, 0.0);
            vT = vUv + vec2(0.0, texelSize.y);
            vB = vUv - vec2(0.0, texelSize.y);
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    \`,

    displayFrag: \`
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform float uIntensity;
        void main () {
            vec3 c = texture2D(uTexture, vUv).rgb;
            float lum = max(c.r, max(c.g, c.b));
            float a = smoothstep(0.0, 0.55, lum) * uIntensity;
            gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
        }
    \`,

    splatFrag: \`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTarget;
        uniform float aspectRatio;
        uniform vec3 color;
        uniform vec2 point;
        uniform float radius;
        void main () {
            vec2 p = vUv - point.xy;
            p.x *= aspectRatio;
            vec3 splat = exp(-dot(p, p) / radius) * color;
            vec3 base = texture2D(uTarget, vUv).xyz;
            gl_FragColor = vec4(base + splat, 1.0);
        }
    \`,

    // Ручной bilerp — только когда аппаратный LINEAR недоступен
    advectionManualFrag: \`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform vec2 dyeTexelSize;
        uniform float dt;
        uniform float dissipation;
        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;
            vec2 iuv = floor(st);
            vec2 fuv = fract(st);
            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }
        void main () {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = bilerp(uSource, coord, dyeTexelSize) * dissipation;
        }
    \`,

    // dyeTexelSize здесь не объявлен — он не нужен и был бы мёртвым uniform'ом
    advectionLinearFrag: \`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform float dt;
        uniform float dissipation;
        void main () {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = texture2D(uSource, coord) * dissipation;
        }
    \`,

    divergenceFrag: \`
        precision mediump float;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).x;
            float R = texture2D(uVelocity, vR).x;
            float T = texture2D(uVelocity, vT).y;
            float B = texture2D(uVelocity, vB).y;
            vec2 C = texture2D(uVelocity, vUv).xy;
            if (vL.x < 0.0) { L = -C.x; }
            if (vR.x > 1.0) { R = -C.x; }
            if (vT.y > 1.0) { T = -C.y; }
            if (vB.y < 0.0) { B = -C.y; }
            gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
        }
    \`,

    curlFrag: \`
        precision mediump float;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uVelocity, vL).y;
            float R = texture2D(uVelocity, vR).y;
            float T = texture2D(uVelocity, vT).x;
            float B = texture2D(uVelocity, vB).x;
            gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
        }
    \`,

    vorticityFrag: \`
        precision highp float;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform float curl;
        uniform float dt;
        void main () {
            float L = texture2D(uCurl, vL).x;
            float R = texture2D(uCurl, vR).x;
            float T = texture2D(uCurl, vT).x;
            float B = texture2D(uCurl, vB).x;
            float C = texture2D(uCurl, vUv).x;
            vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
            force /= length(force) + 0.0001;
            force *= curl * C;
            force.y *= -1.0;
            vec2 vel = texture2D(uVelocity, vUv).xy;
            vel += force * dt;
            vel = clamp(vel, -1000.0, 1000.0);
            gl_FragColor = vec4(vel, 0.0, 1.0);
        }
    \`,

    pressureFrag: \`
        precision mediump float;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        void main () {
            float L = texture2D(uPressure, vL).x;
            float R = texture2D(uPressure, vR).x;
            float T = texture2D(uPressure, vT).x;
            float B = texture2D(uPressure, vB).x;
            float div = texture2D(uDivergence, vUv).x;
            gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
        }
    \`,

    gradientSubtractFrag: \`
        precision mediump float;
        varying vec2 vUv;
        varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        void main () {
            float L = texture2D(uPressure, vL).x;
            float R = texture2D(uPressure, vR).x;
            float T = texture2D(uPressure, vT).x;
            float B = texture2D(uPressure, vB).x;
            vec2 vel = texture2D(uVelocity, vUv).xy;
            vel -= vec2(R - L, T - B);
            gl_FragColor = vec4(vel, 0.0, 1.0);
        }
    \`,

    clearFrag: \`
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        uniform float value;
        void main () {
            gl_FragColor = value * texture2D(uTexture, vUv);
        }
    \`,
};

// ═══════════════════════════════════════════
// WEBGL INIT
// ═══════════════════════════════════════════

function testRenderFormat(iF, f, t) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, iF, 4, 4, 0, f, t, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);

    // ограниченный drain: защита от залипшей ошибки драйвера
    let guard = 0;
    while (gl.getError() !== gl.NO_ERROR && ++guard < 32) {}

    return ok;
}

function getSupportedFormat(iF, f, t) {
    if (testRenderFormat(iF, f, t)) return { internalFormat: iF, format: f, type: t };
    if (iF === gl.R16F)  return getSupportedFormat(gl.RG16F, gl.RG, t);
    if (iF === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA, t);
    return null;
}

// Запрашивает расширения и определяет renderable-форматы.
// Вызывается при init И при webglcontextrestored: по спецификации WebGL
// все объекты расширений после восстановления контекста недействительны,
// их нужно получать заново через getExtension().
function acquireExtensions() {
    const hasColorFloat     = !!gl.getExtension('EXT_color_buffer_float');
    const hasColorHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float');
    // WebGL2 guarantees LINEAR filtering for the HALF_FLOAT texture formats used here.
    const linFilter         = true;
    const hf = gl.HALF_FLOAT;

    let fRGBA = null, fRG = null, fR = null;
    if (hasColorFloat || hasColorHalfFloat) {
        fRGBA = getSupportedFormat(gl.RGBA16F, gl.RGBA, hf);
        fRG   = getSupportedFormat(gl.RG16F,   gl.RG,   hf);
        fR    = getSupportedFormat(gl.R16F,    gl.RED,  hf);
    }

    // Скорость и давление требуют знаковых значений. Не используем RGBA8
    // как fallback: нормализованный UNSIGNED_BYTE обрезает отрицательную скорость.
    // Если подходящие float render targets недоступны, симуляция должна отключиться.
    if (!fRGBA || !fRG || !fR) return null;

    return {
        supportLinearFiltering: linFilter,
        formatRGBA: fRGBA, formatRG: fRG, formatR: fR,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048,
    };
}

function initGL(offscreen) {
    canvas = offscreen;
    gl = canvas.getContext('webgl2', {
        alpha: true, depth: false, stencil: false, antialias: false,
        preserveDrawingBuffer: false, premultipliedAlpha: false,
        powerPreference: 'high-performance', desynchronized: true,
        failIfMajorPerformanceCaveat: false,
    });
    if (!gl) { self.postMessage({ type: 'error', msg: 'WebGL2 unavailable' }); return false; }

    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    let renderer = 'unknown';
    try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    } catch (_) {}
    self.postMessage({ type: 'renderer', renderer: renderer });

    // Жёсткий отказ от программного растеризатора
    if (/swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer)) {
        self.postMessage({ type: 'unsupported', reason: 'software_renderer', renderer: renderer });
        gl = null;
        return false;
    }

    ext = acquireExtensions();
    if (!ext) {
        self.postMessage({ type: 'unsupported', reason: 'no_float_render', renderer: renderer });
        gl = null;
        return false;
    }
    resetTexCache();

    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // ── Адаптивный профиль качества ──
    // low:  Intel UHD/HD Graphics (требуется именно "hd graphics" —
    //       Intel Arc и Iris Xe сюда НЕ попадают), старые Adreno/Mali
    // high: дискретные GeForce любого поколения, Radeon RX 5xx+,
    //       Radeon Pro WX / Vega 6x+, Intel Arc Axxx, Apple Mx
    //       (Radeon RX Vega 8/11 — это iGPU, в high НЕ попадает)
    let tier = 'default';
    if (/intel.*(uhd|hd) graphics|adreno [0-5]|mali-g[0-5]/i.test(renderer)) {
        tier = 'low';
        CONFIG.DYE_RESOLUTION = 384;
        CONFIG.MAX_DPR = 1.0;
        CONFIG.PRESSURE_ITERATIONS = 6;
    } else if (/rtx|gtx|geforce|radeon rx [5-9]|radeon (vega|pro) (wx|vii|[6-9])|arc[^,]*a[3-9]\\d{2}|apple m[1-9]/i.test(renderer)) {
        tier = 'high';
        CONFIG.DYE_RESOLUTION = 640;
        CONFIG.MAX_DPR = 1.75;
        CONFIG.PRESSURE_ITERATIONS = 10;
    }

    // ВАЖНО: CONFIG в воркере — это КОПИЯ (structured clone).
    // Главный поток считает pixelW/pixelH по своему MAX_DPR,
    // поэтому новое значение надо отправить обратно.
    self.postMessage({
        type: 'profile',
        tier: tier,
        dye: CONFIG.DYE_RESOLUTION,
        dpr: CONFIG.MAX_DPR,
        iter: CONFIG.PRESSURE_ITERATIONS,
        linear: ext.supportLinearFiltering,
    });

    return true;
}

function onContextLost(e) {
    e.preventDefault();
    contextLost = true;
    ready = false;
    velocity = dye = pressure = null;
    divergenceFBO = curlFBO = null;
    simW = simH = dyeW = dyeH = 0;
    activeProgram = null;
    resetTexCache();
    self.postMessage({ type: 'contextlost' });
}

function onContextRestored() {
    if (destroyed || !gl) return;
    contextLost = false;
    activeProgram = null;
    programs = {};

    // Объекты расширений после restore недействительны — получаем заново.
    // ДО compileAllShaders(): от supportLinearFiltering зависит, какой
    // вариант advection компилируется; от format* — создание FBO.
    const prevLinear = ext ? ext.supportLinearFiltering : null;
    ext = acquireExtensions();
    if (!ext) {
        self.postMessage({ type: 'unsupported', reason: 'no_float_render' });
        gl = null;
        return;
    }
    resetTexCache();
    if (prevLinear !== null && prevLinear !== ext.supportLinearFiltering) {
        self.postMessage({
            type: 'warn',
            msg: 'linear filtering changed after restore: ' + prevLinear +
                 ' -> ' + ext.supportLinearFiltering + ' (advection recompiled)',
        });
    }

    if (!compileAllShaders()) {
        self.postMessage({ type: 'error', msg: 'shader recompile failed' });
        return;
    }
    initGeometry();

    if (cssWidth >= 2 && cssHeight >= 2) {
        simW = simH = dyeW = dyeH = 0;
        // После restore все FBO пустые → холст прозрачный до следующего
        // idle-сплэша (до 2.6 с). Разрешаем стартовые брызги повторно.
        firstInitDone = false;
        updateFBOs();
    } else {
        firstInitDone = false;   // засеем при ближайшем 'resize'
    }

    self.postMessage({ type: 'contextrestored' });
}

// ═══════════════════════════════════════════
// SHADER COMPILATION
// ═══════════════════════════════════════════

function compileShader(type, source) {
    let src = source;
    if (type === gl.FRAGMENT_SHADER) {
        src = '#version 300 es\\n' + src
            .replace(/precision\\s+(highp|mediump|lowp)\\s+float\\s*;/,
                     'precision \$1 float;\\nout vec4 fragColor;')
            .replace(/\\bvarying\\b/g, 'in')
            .replace(/\\btexture2D\\b/g, 'texture')
            .replace(/\\bgl_FragColor\\b/g, 'fragColor');
    } else {
        src = '#version 300 es\\n' + src
            .replace(/\\battribute\\b/g, 'in')
            .replace(/\\bvarying\\b/g, 'out');
    }
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        self.postMessage({ type: 'error', msg: 'Shader: ' + gl.getShaderInfoLog(shader) });
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProg(vsSrc, fsSrc) {
    const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return null;
    }
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms: uniforms };
}

function compileAllShaders() {
    const v = SHADERS.baseVertex;
    const useLinear = ext.supportLinearFiltering;

    // в linear-варианте uniform dyeTexelSize отсутствует
    advNeedsDyeTexel = !useLinear;

    const list = {
        display: SHADERS.displayFrag,
        splat: SHADERS.splatFrag,
        advection: useLinear ? SHADERS.advectionLinearFrag : SHADERS.advectionManualFrag,
        divergence: SHADERS.divergenceFrag,
        curl: SHADERS.curlFrag,
        vorticity: SHADERS.vorticityFrag,
        pressure: SHADERS.pressureFrag,
        gradientSubtract: SHADERS.gradientSubtractFrag,
        clear: SHADERS.clearFrag,
    };
    for (const key in list) {
        const p = createProg(v, list[key]);
        if (!p) {
            // Не оставляем программы, созданные до ошибки компиляции/линковки.
            for (const k in programs) {
                if (programs[k] && programs[k].program) gl.deleteProgram(programs[k].program);
            }
            programs = {};
            activeProgram = null;
            return false;
        }
        programs[key] = p;
    }
    return true;
}

// ═══════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════

function initGeometry() {
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);

    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);

    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
}

// ═══════════════════════════════════════════
// FBO
// ═══════════════════════════════════════════

function createFBO(w, h, fmt, filtering) {
    w = Math.max(2, w|0); h = Math.max(2, h|0);

    // прямая работа со слотом 0 в обход bindTex -> инвалидируем кэш слота 0
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, fmt.type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(fbo);
        boundTex[0] = null;
        return null;
    }

    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    boundTex[0] = null;

    return {
        texture: texture, fbo: fbo, width: w, height: h,
        texelSizeX: 1/w, texelSizeY: 1/h,
        attach: function (slot) { return bindTex(slot, texture); },
    };
}

function createDoubleFBO(w, h, fmt, filtering) {
    const a = createFBO(w, h, fmt, filtering);
    const b = createFBO(w, h, fmt, filtering);
    if (!a || !b) { destroyFBO(a); destroyFBO(b); return null; }
    let f1 = a, f2 = b;
    return {
        width: a.width, height: a.height,
        texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
        get read() { return f1; },
        get write() { return f2; },
        swap: function () { const t = f1; f1 = f2; f2 = t; },
        all: function () { return [f1, f2]; },
    };
}

function destroyFBO(f) {
    if (!f || !glAlive()) return;
    if (f.texture) gl.deleteTexture(f.texture);
    if (f.fbo) gl.deleteFramebuffer(f.fbo);
}

function destroyDoubleFBO(d) {
    if (!d) return;
    const arr = d.all();
    for (let i = 0; i < arr.length; i++) destroyFBO(arr[i]);
}

function destroyAllFBOs() {
    destroyDoubleFBO(velocity);
    destroyDoubleFBO(dye);
    destroyDoubleFBO(pressure);
    destroyFBO(divergenceFBO);
    destroyFBO(curlFBO);
    velocity = dye = pressure = null;
    divergenceFBO = curlFBO = null;
    ready = false;
    resetTexCache();
}

// Полная очистка: FBO + программы + VAO + буферы + контекст
function cleanUpAll() {
    destroyed = true;
    ready = false;
    rafScheduled = false;

    if (glAlive()) {
        gl.useProgram(null);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        destroyAllFBOs();

        for (const k in programs) {
            if (programs[k] && programs[k].program) gl.deleteProgram(programs[k].program);
        }
        if (quadBuffer)  gl.deleteBuffer(quadBuffer);
        if (indexBuffer) gl.deleteBuffer(indexBuffer);
        if (vao)         gl.deleteVertexArray(vao);

        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) { try { lose.loseContext(); } catch (_) {} }
    }

    programs = {};
    activeProgram = null;
    quadBuffer = null;
    indexBuffer = null;
    vao = null;

    if (canvas) {
        canvas.removeEventListener('webglcontextlost', onContextLost);
        canvas.removeEventListener('webglcontextrestored', onContextRestored);
    }

    simW = simH = dyeW = dyeH = 0;
    cssWidth = cssHeight = 0;
    gl = null; ext = null; canvas = null;
    resetTexCache();

    self.postMessage({ type: 'destroyed' });
}

function calcGrid(base) {
    if (cssWidth < 2 || cssHeight < 2) return null;
    let aspect = cssWidth / cssHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(base);
    const max = Math.round(base * aspect);
    const cap = ext.maxTextureSize;
    let w, h;
    if (cssWidth > cssHeight) { w = max; h = min; } else { w = min; h = max; }
    return { width: clamp(w, 2, cap), height: clamp(h, 2, cap) };
}

function updateFBOs() {
    if (!glAlive() || !ext) return false;

    const sr = calcGrid(CONFIG.SIM_RESOLUTION);
    const dr = calcGrid(CONFIG.DYE_RESOLUTION);
    if (!sr || !dr) return false;

    if (ready &&
        sr.width === simW && sr.height === simH &&
        dr.width === dyeW && dr.height === dyeH) {
        return true;
    }

    destroyAllFBOs();

    const filt = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    velocity      = createDoubleFBO(sr.width, sr.height, ext.formatRG,   filt);
    dye           = createDoubleFBO(dr.width, dr.height, ext.formatRGBA, filt);
    pressure      = createDoubleFBO(sr.width, sr.height, ext.formatR,    gl.NEAREST);
    divergenceFBO = createFBO(sr.width, sr.height, ext.formatR, gl.NEAREST);
    curlFBO       = createFBO(sr.width, sr.height, ext.formatR, gl.NEAREST);

    if (!velocity || !dye || !pressure || !divergenceFBO || !curlFBO) {
        destroyAllFBOs();
        simW = simH = dyeW = dyeH = 0;
        self.postMessage({ type: 'error', msg: 'FBO allocation failed' });
        return false;
    }

    simW = sr.width;  simH = sr.height;
    dyeW = dr.width;  dyeH = dr.height;
    ready = true;

    // стартовые брызги при первом запуске и после context restore,
    // но НЕ на каждый ресайз
    if (!firstInitDone) {
        firstInitDone = true;
        multipleSplats(4);
    }
    return true;
}

// ═══════════════════════════════════════════
// BLIT / USE
// ═══════════════════════════════════════════

function blit(target) {
    if (!target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
}

function use(prog) {
    if (activeProgram !== prog) {
        gl.useProgram(prog.program);
        activeProgram = prog;
    }
    return prog.uniforms;
}

// ═══════════════════════════════════════════
// SPLAT
// ═══════════════════════════════════════════

function splat(x, y, dx, dy) {
    if (!ready) return;
    gl.bindVertexArray(vao);
    const aspect = canvas.width / canvas.height;
    const radius = correctRadius(CONFIG.SPLAT_RADIUS, aspect);

    gl.disable(gl.BLEND);
    const u = use(programs.splat);
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, radius);

    gl.uniform1i(u.uTarget, velocity.read.attach(SLOT_VELOCITY));
    gl.uniform3f(u.color, dx, dy, 0.0);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(u.uTarget, dye.read.attach(SLOT_VELOCITY));
    gl.uniform3f(u.color, _color.r, _color.g, _color.b);
    blit(dye.write); dye.swap();
}

function multipleSplats(count) {
    for (let i = 0; i < count; i++) {
        fillColorHSV(Math.random(), 0.85, 1.0, 10);
        splat(Math.random(), Math.random(),
              (Math.random()-0.5)*900, (Math.random()-0.5)*900);
    }
}

// ═══════════════════════════════════════════
// SIMULATION STEP (Навье–Стокс, Stable Fluids)
// ═══════════════════════════════════════════

function step(dt) {
    gl.disable(gl.BLEND);
    const vel = velocity, prs = pressure;
    const tsx = vel.texelSizeX, tsy = vel.texelSizeY;

    // ── Curl (завихрённость) ──
    let u = use(programs.curl);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1i(u.uVelocity, vel.read.attach(SLOT_VELOCITY));
    blit(curlFBO);

    // ── Vorticity confinement ──
    u = use(programs.vorticity);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1i(u.uVelocity, vel.read.attach(SLOT_VELOCITY));
    gl.uniform1i(u.uCurl, curlFBO.attach(SLOT_EXTRA));
    gl.uniform1f(u.curl, CONFIG.CURL_STRENGTH);
    gl.uniform1f(u.dt, dt);
    blit(vel.write); vel.swap();

    // ── Divergence ──
    u = use(programs.divergence);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1i(u.uVelocity, vel.read.attach(SLOT_VELOCITY));
    blit(divergenceFBO);

    // ── Затухание давления ──
    u = use(programs.clear);
    gl.uniform1i(u.uTexture, prs.read.attach(SLOT_VELOCITY));
    gl.uniform1f(u.value, CONFIG.PRESSURE_DECAY);
    blit(prs.write); prs.swap();

    // ── Решение уравнения Пуассона (Jacobi) ──
    u = use(programs.pressure);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1i(u.uDivergence, divergenceFBO.attach(SLOT_SOURCE));
    for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(u.uPressure, prs.read.attach(SLOT_VELOCITY));
        blit(prs.write); prs.swap();
    }

    // ── Проекция: вычитание градиента давления ──
    u = use(programs.gradientSubtract);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1i(u.uPressure, prs.read.attach(SLOT_SOURCE));
    gl.uniform1i(u.uVelocity, vel.read.attach(SLOT_VELOCITY));
    blit(vel.write); vel.swap();

    // ── Advection: скорость, затем краситель (одна программа) ──
    u = use(programs.advection);
    gl.uniform2f(u.texelSize, tsx, tsy);
    gl.uniform1f(u.dt, dt);

    if (advNeedsDyeTexel) gl.uniform2f(u.dyeTexelSize, tsx, tsy);
    const velSlot = vel.read.attach(SLOT_VELOCITY);
    gl.uniform1i(u.uVelocity, velSlot);
    gl.uniform1i(u.uSource, velSlot);
    gl.uniform1f(u.dissipation, CONFIG.VELOCITY_DISSIPATION);
    blit(vel.write); vel.swap();

    if (advNeedsDyeTexel) gl.uniform2f(u.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(u.uVelocity, vel.read.attach(SLOT_VELOCITY));
    gl.uniform1i(u.uSource, dye.read.attach(SLOT_SOURCE));
    gl.uniform1f(u.dissipation, CONFIG.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
}

function render() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Фрагментный шейдер уже вычисляет итоговую straight-alpha прозрачность.
    // Холст очищен, а fullscreen quad закрывает весь viewport, поэтому blending
    // здесь только повторно умножал бы RGB на alpha и искажал итоговую прозрачность.
    gl.disable(gl.BLEND);

    const u = use(programs.display);
    gl.uniform1i(u.uTexture, dye.read.attach(SLOT_VELOCITY));
    if (u.uIntensity) gl.uniform1f(u.uIntensity, 1.0);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

    gl.disable(gl.BLEND);
}

// ═══════════════════════════════════════════
// INPUT (обрабатывается ровно раз в кадр)
// ═══════════════════════════════════════════

// Накопленная дельта расходуется порциями, чтобы перетаскивание окна
// выглядело непрерывным, а не «чихающим» на частоте опроса.
function processWindow() {
    const takeX = windowDeltaX * CONFIG.WINDOW_SMOOTH;
    const takeY = windowDeltaY * CONFIG.WINDOW_SMOOTH;
    windowDeltaX -= takeX;
    windowDeltaY -= takeY;
    if (Math.abs(windowDeltaX) < 0.05) windowDeltaX = 0;
    if (Math.abs(windowDeltaY) < 0.05) windowDeltaY = 0;

    winVelX = winVelX * 0.82 + takeX * 0.18;
    winVelY = winVelY * 0.82 + takeY * 0.18;

    const speed = Math.hypot(winVelX, winVelY);
    if (speed < CONFIG.WINDOW_MIN_SPEED) return;

    const n = Math.min(1 + ((speed / CONFIG.WINDOW_SPEED_DIVISOR)|0), CONFIG.WINDOW_MAX_SPLATS);
    const intensity = clamp(speed / 3, 0.4, 3.0);
    fillColorHSV(Math.random(), 0.85, 1.0, 10 * intensity);

    for (let i = 0; i < n; i++) {
        const j = 0.5 + Math.random() * 0.5;
        splat(Math.random(), Math.random(),
            -winVelX * CONFIG.WINDOW_FORCE_MULTIPLIER * j,
             winVelY * CONFIG.WINDOW_FORCE_MULTIPLIER * j);
    }
}

function processMouse() {
    if (!ready || !mouseInside) return;

    const nx = mouseNX, ny = mouseNY;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
        mousePrevNX = -1; mousePrevNY = -1;
        return;
    }
    if (mousePrevNX < 0) { mousePrevNX = nx; mousePrevNY = ny; return; }

    const ddx = nx - mousePrevNX;
    const ddy = ny - mousePrevNY;

    if (Math.abs(ddx) + Math.abs(ddy) < CONFIG.MOUSE_MIN_DELTA) return;

    if (Math.abs(ddx) > CONFIG.MOUSE_MAX_DELTA || Math.abs(ddy) > CONFIG.MOUSE_MAX_DELTA) {
        mousePrevNX = nx; mousePrevNY = ny;
        return;
    }

    mousePrevNX = nx; mousePrevNY = ny;
    fillColorHSV(Math.random(), 0.85, 1.0, 10);
    splat(nx, ny, ddx * CONFIG.SPLAT_FORCE, ddy * CONFIG.SPLAT_FORCE);
}

function idleSplat(now) {
    if (now - lastIdleSplat < CONFIG.IDLE_SPLAT_INTERVAL) return;
    lastIdleSplat = now;
    const a = Math.random() * Math.PI * 2;
    fillColorHSV(Math.random(), 0.85, 1.0, 8);
    splat(0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8,
          Math.cos(a) * CONFIG.IDLE_SPLAT_FORCE,
          Math.sin(a) * CONFIG.IDLE_SPLAT_FORCE);
}

// ═══════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════

function loop(now) {
    rafScheduled = false;
    if (destroyed) return;
    requestAnimationFrame(loop);
    rafScheduled = true;

    if (contextLost || !ready || !glAlive()) return;

    const elapsed = now - lastTime;
    if (elapsed < FRAME_INTERVAL - 0.5) return;
    lastTime = now - (elapsed % FRAME_INTERVAL);

    const dt = clamp(elapsed / 1000, 0.001, 1 / 45);

    gl.bindVertexArray(vao);

    if (windowDeltaX !== 0 || windowDeltaY !== 0 ||
        Math.abs(winVelX) > 0.01 || Math.abs(winVelY) > 0.01) {
        processWindow();
    }
    processMouse();
    idleSplat(now);
    step(dt);
    render();
}

// ═══════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════

self.onmessage = function (e) {
    const msg = e.data;
    if (destroyed && msg.type !== 'init') return;

    switch (msg.type) {
        case 'init':
            if (destroyed) return;
            CONFIG = msg.config;
            FRAME_INTERVAL = 1000 / CONFIG.TARGET_FPS;
            if (!initGL(msg.canvas)) return;
            if (!compileAllShaders()) {
                self.postMessage({ type: 'error', msg: 'shaders failed' });
                return;
            }
            initGeometry();
            self.postMessage({ type: 'ready' });
            break;

        case 'resize':
            cssWidth = msg.cssW;
            cssHeight = msg.cssH;
            if (glAlive()) {
                canvas.width = msg.pixelW;
                canvas.height = msg.pixelH;
            }
            mousePrevNX = -1; mousePrevNY = -1;
            updateFBOs();
            if (!rafScheduled) {
                lastTime = performance.now();
                lastIdleSplat = lastTime;
                rafScheduled = true;
                requestAnimationFrame(loop);
            }
            break;

        case 'mouse':
            mouseNX = msg.nx;
            mouseNY = msg.ny;
            mouseInside = true;
            break;

        case 'mouseleave':
            mouseInside = false;
            mousePrevNX = -1;
            mousePrevNY = -1;
            break;

        case 'window':
            // DPI/координатный скачок при переходе на другой монитор не должен
            // полностью отключать реакцию флюидов. Ограничиваем импульс, а не
            // отбрасываем его целиком.
            windowDeltaX += clamp(msg.dx, -CONFIG.WINDOW_TELEPORT_PX, CONFIG.WINDOW_TELEPORT_PX);
            windowDeltaY += clamp(msg.dy, -CONFIG.WINDOW_TELEPORT_PX, CONFIG.WINDOW_TELEPORT_PX);
            break;

        case 'destroy':
            cleanUpAll();
            break;
    }
};
`;
    }

    // ========================================================================
    // ГЛАВНЫЙ ПОТОК: МОСТ К WORKER'У
    // ========================================================================
    class FluidBridge {
        constructor(targetElement) {
            this.target = targetElement;
            this.canvas = null;
            this.worker = null;
            this.destroyed = false;
            this.workerReady = false;
            this.blobUrl = null;

            this.rectLeft = 0;
            this.rectTop = 0;
            this.rectW = 1;
            this.rectH = 1;

            this.pendingW = 0;
            this.pendingH = 0;
            this.resizeDirty = false;
            this.lastResizeAt = 0;

            this.prevScreenX = window.screenX || 0;
            this.prevScreenY = window.screenY || 0;

            this.windowPollTimer = null;
            this.resizeTimer = null;
            this.rectRefreshTimer = null;

            this._mouseRafId = 0;
            this._mouseLastNX = 0;
            this._mouseLastNY = 0;

            this._destroyAckReceived = false;
            this._destroyFallbackTimer = null;
            this.originalTargetStyles = null;

            this._onMouseMove = this._onMouseMove.bind(this);
            this._onMouseLeave = this._onMouseLeave.bind(this);
            this._onMouseEnter = this._onMouseEnter.bind(this);
            this._pollWindow = this._pollWindow.bind(this);
            this._checkResize = this._checkResize.bind(this);
            this._flushMouse = this._flushMouse.bind(this);
            this._refreshRect = this._refreshRect.bind(this);

            try {
                this._init();
            } catch (err) {
                // Инициализация могла частично создать DOM/Worker/GPU-ресурсы.
                // Освобождаем всё созданное до проброса ошибки в Manager.
                this.destroy();
                throw err;
            }
        }

        _captureTargetStyles(el) {
            const properties = [
                'background', 'background-color', 'background-image',
                'isolation', 'position', 'overflow'
            ];
            this.originalTargetStyles = {};
            for (const property of properties) {
                this.originalTargetStyles[property] = {
                    value: el.style.getPropertyValue(property),
                    priority: el.style.getPropertyPriority(property)
                };
            }
        }

        _restoreTargetStyles() {
            if (!this.target || !this.originalTargetStyles) return;
            for (const property in this.originalTargetStyles) {
                const saved = this.originalTargetStyles[property];
                if (saved.value) {
                    this.target.style.setProperty(property, saved.value, saved.priority);
                } else {
                    this.target.style.removeProperty(property);
                }
            }
            this.originalTargetStyles = null;
        }

        _init() {
            injectStyles();

            const el = this.target;
            this._captureTargetStyles(el);
            el.style.setProperty('background', 'transparent', 'important');
            el.style.setProperty('background-color', 'transparent', 'important');
            el.style.setProperty('background-image', 'none', 'important');
            el.style.isolation = 'isolate';
            if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
            el.style.overflow = 'hidden';

            this.canvas = document.createElement('canvas');
            this.canvas.id = 'fluid-sim-canvas';
            this.canvas.width = 2;
            this.canvas.height = 2;
            el.insertBefore(this.canvas, el.firstChild);

            let offscreen;
            try {
                offscreen = this.canvas.transferControlToOffscreen();
            } catch (err) {
                console.error('[Fluid] OffscreenCanvas not supported:', err);
                this.destroy();
                Manager.disableForever('offscreen_canvas_unavailable');
                return;
            }

            const blob = new Blob([getWorkerSource()], { type: 'application/javascript' });
            this.blobUrl = URL.createObjectURL(blob);
            try {
                this.worker = new Worker(this.blobUrl);
            } catch (err) {
                console.error('[Fluid] Worker creation failed:', err);
                this.destroy();
                Manager.disableForever('worker_creation_failed');
                return;
            }

            this.worker.onmessage = (e) => {
                const msg = e.data;
                switch (msg.type) {
                    case 'ready':
                        this.workerReady = true;
                        if (this.blobUrl) {
                            URL.revokeObjectURL(this.blobUrl);
                            this.blobUrl = null;
                        }
                        this._sendResize();
                        console.log('[Fluid] Worker ready');
                        break;

                    case 'renderer':
                        console.log('[Fluid] GPU renderer:', msg.renderer);
                        break;

                    case 'profile':
                        console.log(
                            '[Fluid] Profile [' + msg.tier + '] — dye:', msg.dye,
                            '| dpr:', msg.dpr,
                            '| pressure iters:', msg.iter,
                            '| linear filter:', msg.linear
                        );
                        // КРИТИЧНО: CONFIG в воркере — отдельная копия.
                        // MAX_DPR используется ЗДЕСЬ при расчёте pixelW/pixelH,
                        // поэтому синхронизируем значение обратно.
                        if (msg.dpr && msg.dpr !== CONFIG.MAX_DPR) {
                            CONFIG.MAX_DPR = msg.dpr;
                            this.resizeDirty = true;
                            this.lastResizeAt = 0;
                        }
                        break;

                    case 'unsupported':
                        if (msg.reason === 'no_float_render') {
                            console.warn('[Fluid] WebGL2 float color-buffer rendering is unavailable; fluid simulation disabled.');
                        } else {
                            console.warn('[Fluid] ⚠️ Unsupported renderer:', msg.renderer);
                            console.warn('[Fluid] Включите аппаратное ускорение в настройках Steam ' +
                                         '(Настройки → Интерфейс → Аппаратное ускорение).');
                        }
                        Manager.disableForever(msg.reason);
                        break;

                    case 'contextlost':
                        console.warn('[Fluid] WebGL context lost in worker');
                        break;

                    case 'contextrestored':
                        console.log('[Fluid] WebGL context restored');
                        // Reapply backing-store dimensions in case the target resized while the context was lost.
                        this._sendResize();
                        break;

                    case 'warn':
                        console.warn('[Fluid] Worker:', msg.msg);
                        break;

                    case 'destroyed':
                        this._destroyAckReceived = true;
                        this._finalizeWorkerTermination();
                        break;

                    case 'error':
                        console.error('[Fluid] Worker:', msg.msg);
                        Manager.disableForever('worker_init_error: ' + (msg.msg || 'unknown'));
                        break;
                }
            };

            this.worker.onerror = (err) => {
                console.error('[Fluid] Worker fatal:', err.message || err);
                Manager.disableForever('worker_fatal_error: ' + (err.message || 'unknown'));
            };

            this.worker.postMessage(
                { type: 'init', canvas: offscreen, config: CONFIG },
                [offscreen]
            );

            const rect = el.getBoundingClientRect();
            this.pendingW = rect.width;
            this.pendingH = rect.height;
            this._updateCachedRect(rect);
            this.resizeDirty = true;
            this.lastResizeAt = 0;

            this.resizeObserver = new ResizeObserver((entries) => {
                const cr = entries[entries.length - 1].contentRect;
                if (Math.abs(cr.width - this.pendingW) < 4 &&
                    Math.abs(cr.height - this.pendingH) < 4) return;
                this.pendingW = cr.width;
                this.pendingH = cr.height;
                this.resizeDirty = true;
                this.lastResizeAt = performance.now();
            });
            this.resizeObserver.observe(el);

            this.resizeTimer = setInterval(this._checkResize, 100);
            this.rectRefreshTimer = setInterval(this._refreshRect, CONFIG.RECT_REFRESH_INTERVAL);

            el.addEventListener('mousemove', this._onMouseMove, { passive: true });
            el.addEventListener('mouseleave', this._onMouseLeave, { passive: true });
            el.addEventListener('mouseenter', this._onMouseEnter, { passive: true });

            this.windowPollTimer = setInterval(this._pollWindow, CONFIG.WINDOW_POLL_INTERVAL);

            console.log('[Fluid] Bridge attached');
        }

        _updateCachedRect(rect) {
            this.rectLeft = rect.left;
            this.rectTop = rect.top;
            this.rectW = rect.width || 1;
            this.rectH = rect.height || 1;
        }

        _refreshRect() {
            if (this.destroyed || !this.target || !this.target.isConnected) return;
            this._updateCachedRect(this.target.getBoundingClientRect());
        }

        _sendResize() {
            if (this.destroyed || !this.workerReady || !this.worker) return;
            const w = this.pendingW, h = this.pendingH;
            if (w < 2 || h < 2) return;

            this._updateCachedRect(this.target.getBoundingClientRect());

            const ratio = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
            const maxTex = 4096;
            const pixelW = clamp(Math.floor(w * ratio), 2, maxTex);
            const pixelH = clamp(Math.floor(h * ratio), 2, maxTex);

            this.worker.postMessage({ type: 'resize', cssW: w, cssH: h, pixelW, pixelH });
        }

        _checkResize() {
            if (this.destroyed || !this.resizeDirty) return;
            if (performance.now() - this.lastResizeAt < CONFIG.RESIZE_DEBOUNCE) return;
            this.resizeDirty = false;
            this._sendResize();
        }

        // ── Мышь: handler = 2 записи, postMessage троттлится через rAF ──
        _onMouseMove(e) {
            if (this.destroyed) return;
            this._mouseLastNX = (e.clientX - this.rectLeft) / this.rectW;
            this._mouseLastNY = 1 - (e.clientY - this.rectTop) / this.rectH;
            if (!this._mouseRafId) {
                this._mouseRafId = requestAnimationFrame(this._flushMouse);
            }
        }

        _flushMouse() {
            this._mouseRafId = 0;
            if (this.destroyed || !this.worker || !this.workerReady) return;
            this.worker.postMessage({
                type: 'mouse',
                nx: this._mouseLastNX,
                ny: this._mouseLastNY,
            });
        }

        _onMouseLeave() {
            if (this.destroyed) return;
            if (this._mouseRafId) {
                cancelAnimationFrame(this._mouseRafId);
                this._mouseRafId = 0;
            }
            if (this.worker) this.worker.postMessage({ type: 'mouseleave' });
        }

        _onMouseEnter(e) {
            if (this.destroyed || !this.worker) return;
            const r = this.target.getBoundingClientRect();
            this._updateCachedRect(r);
            const nx = (e.clientX - r.left) / (r.width || 1);
            const ny = 1 - (e.clientY - r.top) / (r.height || 1);
            this.worker.postMessage({ type: 'mouse', nx, ny });
        }

        // ── Окно: 20 Гц. Чаще кадра не нужно, реже — видны «ступеньки» ──
        _pollWindow() {
            if (this.destroyed || !this.worker || !this.workerReady) return;
            const cx = window.screenX || 0;
            const cy = window.screenY || 0;
            const dx = cx - this.prevScreenX;
            const dy = cy - this.prevScreenY;
            this.prevScreenX = cx;
            this.prevScreenY = cy;
            // При переносе между мониторами экранные координаты могут резко
            // измениться из-за разного DPI. Обновляем базу и в hidden-состоянии,
            // чтобы после возврата не получить устаревший скачок координат.
            if (document.hidden || (dx === 0 && dy === 0)) return;
            this.worker.postMessage({ type: 'window', dx, dy });
        }

        _finalizeWorkerTermination() {
            if (!this.worker) return;
            if (this._destroyFallbackTimer) {
                clearTimeout(this._destroyFallbackTimer);
                this._destroyFallbackTimer = null;
            }
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker.terminate();
            this.worker = null;
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this._destroyAckReceived = false;

            if (this.windowPollTimer)  { clearInterval(this.windowPollTimer);  this.windowPollTimer = null; }
            if (this.resizeTimer)      { clearInterval(this.resizeTimer);      this.resizeTimer = null; }
            if (this.rectRefreshTimer) { clearInterval(this.rectRefreshTimer); this.rectRefreshTimer = null; }
            if (this.resizeObserver)   { this.resizeObserver.disconnect();     this.resizeObserver = null; }
            if (this._mouseRafId)      { cancelAnimationFrame(this._mouseRafId); this._mouseRafId = 0; }

            if (this.target) {
                this.target.removeEventListener('mousemove', this._onMouseMove);
                this.target.removeEventListener('mouseleave', this._onMouseLeave);
                this.target.removeEventListener('mouseenter', this._onMouseEnter);
            }

            if (this.blobUrl) {
                URL.revokeObjectURL(this.blobUrl);
                this.blobUrl = null;
            }

            // Graceful: даём воркеру очистить GPU-ресурсы, потом terminate
            if (this.worker) {
                try { this.worker.postMessage({ type: 'destroy' }); } catch (_) {}
                this._destroyFallbackTimer = setTimeout(() => {
                    if (!this._destroyAckReceived) {
                        console.warn('[Fluid] destroy ack timeout — forcing terminate');
                        this._finalizeWorkerTermination();
                    }
                }, CONFIG.DESTROY_GRACE_MS);
            }

            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
            this.canvas = null;

            // Возвращаем только свойства, изменённые симуляцией, не затрагивая
            // остальные inline-стили, которые Steam мог изменить самостоятельно.
            this._restoreTargetStyles();

            console.log('[Fluid] Bridge destroyed');
        }
    }

    // ========================================================================
    // MANAGER
    // ========================================================================
    const Manager = {
        bridge: null,
        pollDelay: CONFIG.POLL_MIN,
        pollTimer: null,
        healthTimer: null,
        running: false,
        disabled: false,
        disabledReason: null,

        // Без этого healthTimer бесконечно пересоздавал бы воркеры на SwiftShader
        disableForever(reason) {
            if (this.disabled) return;
            this.disabled = true;
            this.disabledReason = reason || 'unknown';
            console.warn('[Fluid] Permanently disabled:', this.disabledReason);
            this.stop();
        },

        tryAttach() {
            if (this.disabled) return false;
            if (this.bridge && !this.bridge.destroyed && this.bridge.target.isConnected) return true;
            if (this.bridge) { this.bridge.destroy(); this.bridge = null; }

            // findTarget сам пропускает элементы с уже существующим canvas
            const el = findTarget();
            if (!el) return false;

            try {
                const bridge = new FluidBridge(el);
                if (this.disabled || bridge.destroyed) {
                    this.bridge = null;
                    return false;
                }
                this.bridge = bridge;
                return true;
            } catch (err) {
                console.error('[Fluid] init failed:', err);
                this.bridge = null;
                return false;
            }
        },

        schedulePoll() {
            if (this.disabled) return;
            if (this.pollTimer) clearTimeout(this.pollTimer);
            this.pollTimer = setTimeout(() => {
                this.pollTimer = null;
                if (!this.running || this.disabled) return;
                if (this.tryAttach()) { this.pollDelay = CONFIG.POLL_MIN; return; }
                this.pollDelay = Math.min(Math.floor(this.pollDelay * 1.5), CONFIG.POLL_MAX);
                this.schedulePoll();
            }, this.pollDelay);
        },

        _startHealthTimer() {
            if (this.healthTimer || this.disabled) return;
            this.healthTimer = setInterval(() => {
                if (!this.running || this.disabled) return;
                if (!this.bridge || this.bridge.destroyed || !this.bridge.target.isConnected) {
                    if (this.bridge) { this.bridge.destroy(); this.bridge = null; }
                    if (!this.pollTimer) {
                        this.pollDelay = CONFIG.POLL_MIN;
                        this.schedulePoll();
                    }
                }
            }, CONFIG.POLL_HEALTHCHECK);
        },

        start() {
            if (this.running || this.disabled) return;
            this.running = true;
            injectStyles();
            if (!this.tryAttach()) this.schedulePoll();
            this._startHealthTimer();
        },

        stop() {
            this.running = false;
            if (this.pollTimer)   { clearTimeout(this.pollTimer);   this.pollTimer = null; }
            if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
            if (this.bridge)      { this.bridge.destroy();           this.bridge = null; }
            const injectedStyle = document.getElementById('fluid-steam-override');
            if (injectedStyle) injectedStyle.remove();
        },
    };

    // ========================================================================
    // BOOTSTRAP
    // ========================================================================
    function bootstrap() {
        if (document.body) {
            Manager.start();
        } else {
            const t = setInterval(() => {
                if (document.body) { clearInterval(t); Manager.start(); }
            }, 100);
        }
    }

    bootstrap();

    // ========================================================================
    // DEBUG API
    // ========================================================================
    window.__fluid = {
        config: CONFIG,
        manager: Manager,
        get bridge() { return Manager.bridge; },
        get disabled() { return Manager.disabled; },
        restart() {
            if (Manager.disabled) {
                console.warn('[Fluid] disabled (' + Manager.disabledReason + '), cannot restart');
                return;
            }
            Manager.stop();
            Manager.pollDelay = CONFIG.POLL_MIN;
            Manager.start();
        },
        stop() { Manager.stop(); },
        forceEnable() {
            Manager.disabled = false;
            Manager.disabledReason = null;
            Manager.stop();
            Manager.pollDelay = CONFIG.POLL_MIN;
            Manager.start();
        },
    };

})();