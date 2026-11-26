import './styles.css';
import { analysisSize, analyzeReference, type ReferenceAnalysis } from './drawing';
import {
  DrawingEngine, exportStrokeSvg, formatDuration, stages,
  type BrushStyle, type DrawingConfig, type DrawingSnapshot, type Stroke,
} from './engine';
import { encodePng, readStraightPng } from './png';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const canvas = $<HTMLCanvasElement>('#draw-canvas');
const overlay = $<HTMLCanvasElement>('#active-canvas');
const manual = $<HTMLCanvasElement>('#manual-canvas');
const engine = new DrawingEngine(canvas, overlay);
const referenceInput = $<HTMLInputElement>('#reference-input');
const projectInput = $<HTMLInputElement>('#project-input');
const referenceImg = $<HTMLImageElement>('#reference-img');
const sourcePreview = $('#source-preview');
const frame = $('#canvas-frame');
const stageContainer = $('#canvas-stage');
const pen = $('#virtual-pen');
const start = $<HTMLButtonElement>('#start-btn');
const analyze = $<HTMLButtonElement>('#analyze-btn');
const play = $<HTMLButtonElement>('#play-btn');
const timeline = $<HTMLInputElement>('#timeline-range');
const stageRows = $$('.stage-row');
const style = $<HTMLSelectElement>('#style-select');
const budget = $<HTMLSelectElement>('#budget-select');
const fidelity = $<HTMLSelectElement>('#fidelity-select');
const complexity = $<HTMLInputElement>('#complexity-range');
const edge = $<HTMLInputElement>('#edge-range');

let reference: { image: HTMLImageElement; dataUrl: string; name: string } | null = null;
let analysis: ReferenceAnalysis | null = null;
let loadId = 0;
let analysisId = 0;
let toastTimer = 0;
let zoom = 1;
let drawingFormat: 'live' | 'legacy' = 'live';
let manualMode = false;
let manualHasInk = false;
let manualLast: { x: number; y: number } | null = null;
let lastPaint = -Infinity;
let wasDone = false;
let exporting = false;

const defaults: DrawingConfig = {
  style: 'colored-pencil', strokeBudget: 3000, minBrushSize: 0.8, maxBrushSize: 6,
  colorAccuracy: 0.8, edgePreservation: 0.75, textureDetail: 0.55, strokeComplexity: 0.6,
  shadingAccuracy: 0.65, refinementIterations: 3, artisticSimplification: 0.2, fidelity: 'exact',
};

function config(): DrawingConfig {
  return {
    ...defaults, style: style.value as BrushStyle, strokeBudget: Number(budget.value),
    fidelity: fidelity.value === 'artistic' ? 'artistic' : 'exact',
    edgePreservation: Number(edge.value) / 100, strokeComplexity: Number(complexity.value) / 100,
  };
}

function text(id: string, value: string) { $(`#${id}`).textContent = value; }

function toast(message: string) {
  window.clearTimeout(toastTimer);
  text('toast', message);
  $('#toast').classList.add('show');
  toastTimer = window.setTimeout(() => $('#toast').classList.remove('show'), 3500);
}

function status(message: string, live = false) {
  text('header-status', message);
  text('footer-message', message);
  $('#live-pip').classList.toggle('drawing', live);
}

function percent(value: number) {
  if (value === 1) return '100%';
  if (value >= 0.99995) return '>99.99%';
  return `${(value * 100).toFixed(2)}%`;
}

function render(snapshot: DrawingSnapshot) {
  pen.style.left = `${snapshot.cursor.x * 100}%`;
  pen.style.top = `${snapshot.cursor.y * 100}%`;
  pen.style.setProperty('--pressure', String(snapshot.pressure));
  pen.classList.toggle('visible', snapshot.running && !snapshot.done);
  pen.classList.toggle('contact', snapshot.phase === 'touch' || snapshot.phase === 'draw');
  if (snapshot.running && performance.now() - lastPaint < 75) return;
  lastPaint = performance.now();

  const percentage = snapshot.done ? 100 : Math.min(99, Math.round(snapshot.progress * 100));
  text('progress-value', `${percentage}%`);
  $('#progress-ring').style.setProperty('--progress', `${percentage}%`);
  $('#signal-fill').style.width = `${percentage}%`;
  text('stat-stage', snapshot.stage === 'Ready' ? (analysis ? 'Ready to draw' : 'Awaiting reference') : snapshot.stage);
  text('similarity-label', snapshot.exactMetric ? 'EXACT PIXEL MATCH' : 'COLOR SIMILARITY');
  text('stat-similarity', snapshot.similarity === null ? '—' : percent(snapshot.similarity));
  text('debug-residual', snapshot.similarity === null ? '—' : percent(1 - snapshot.similarity));
  text('stat-strokes', snapshot.completed.toLocaleString());
  text('stat-sps', snapshot.strokesPerSecond > 0 ? snapshot.strokesPerSecond.toFixed(1) : '—');
  text('stat-brush', snapshot.currentBrushSize > 0 ? `${snapshot.currentBrushSize.toFixed(1)} px` : '—');
  text('stat-eta', snapshot.done ? 'Complete' : snapshot.running ? (snapshot.replaying ? 'Replay' : 'Live') : '—');
  text('phase-label', (!snapshot.running && !snapshot.done && snapshot.phase !== 'idle' ? 'paused' : snapshot.phase).toUpperCase());
  text('elapsed-label', `ELAPSED ${formatDuration(snapshot.elapsedMs)}`);
  timeline.max = String(Math.max(1, snapshot.recorded));
  timeline.value = String(snapshot.completed);
  timeline.disabled = snapshot.recorded === 0;
  text('timeline-current', `${snapshot.completed.toLocaleString()} / ${snapshot.recorded.toLocaleString()} recorded`);
  text('timeline-time', formatDuration(snapshot.elapsedMs));
  play.disabled = !analysis;
  play.innerHTML = snapshot.running ? '<span>Ⅱ</span>' : snapshot.done ? '<span>↺</span>' : '<span>▶</span>';
  play.title = snapshot.running ? 'Pause' : snapshot.done ? 'Replay finished drawing' : 'Play';
  play.setAttribute('aria-label', play.title);
  const empty = !reference && !manualHasInk;
  $('#canvas-empty-state').style.display = empty ? 'grid' : 'none';
  text('canvas-title', snapshot.running || snapshot.completed > 0 ? 'Drawing canvas' : 'Blank canvas');

  let stageCount = 0;
  const activeIndex = stages.findIndex((stage) => stage === snapshot.stage);
  for (let i = 0; i < stageRows.length; i++) {
    const row = stageRows[i];
    const count = snapshot.counts[stages[i]];
    const active = snapshot.running && i === activeIndex;
    const completed = count > 0 && (snapshot.done || i < activeIndex);
    row.querySelector('strong')!.textContent = count ? count.toLocaleString() : '—';
    row.querySelector<HTMLElement>('.stage-bar i')!.style.width = completed ? '100%' : active ? '60%' : '0%';
    row.classList.toggle('active', active);
    row.classList.toggle('done', completed);
    if (count) stageCount++;
  }
  text('stage-count', `${stageCount} / ${stages.length}`);
  text('layer-construction', String(snapshot.counts.Construction));
  text('layer-sketch', String(snapshot.counts['Rough sketch'] + snapshot.counts['Refined linework']));
  text('layer-colors', String(snapshot.counts['Base colors'] + snapshot.counts.Shading));
  text('layer-details', String(snapshot.counts['Fine details'] + snapshot.counts['Iterative refinement']));

  if (snapshot.done) {
    const message = snapshot.exactMetric && snapshot.similarity === 1 ? 'Drawing complete · all pixels match' : 'Drawing complete';
    text('canvas-stage-label', 'Complete');
    status(message);
    if (!wasDone && snapshot.elapsedMs > 0) toast(message);
  } else if (snapshot.running) {
    text('canvas-stage-label', `${snapshot.stage} · ${snapshot.phase}`);
    status(snapshot.replaying ? 'Replaying recorded strokes' : 'Drawing live · choosing each mark as it goes', true);
  } else {
    text('canvas-stage-label', snapshot.completed ? 'Paused' : analysis ? 'Ready to draw' : reference ? 'Ready to analyze' : 'Awaiting reference');
    if (analysis) status(snapshot.completed ? 'Drawing paused' : 'Reference analyzed · canvas ready');
  }
  wasDone = snapshot.done;
}

function fitCanvas() {
  const width = analysis?.width ?? 888;
  const height = analysis?.height ?? 600;
  const css = getComputedStyle(stageContainer);
  const horizontal = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
  const vertical = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
  const availableW = Math.max(1, stageContainer.clientWidth - horizontal - 2);
  const availableH = Math.max(1, stageContainer.clientHeight - vertical - 2);
  const size = Math.min(850, availableW, availableH * width / height);
  frame.style.width = `${size}px`;
  frame.style.aspectRatio = `${width} / ${height}`;
}

function resetManual() {
  manual.width = overlay.width;
  manual.height = overlay.height;
  manualHasInk = false;
  manualLast = null;
}

function resetAnalysis() {
  analysisId++;
  analysis = null;
  drawingFormat = 'live';
  manualHasInk = false;
  engine.prepare(null, config());
  resetManual();
  fitCanvas();
  start.disabled = !reference;
  analyze.disabled = !reference;
  analyze.innerHTML = '<span class="spark-glyph">✦</span> Analyze reference';
  text('seed-chip', 'SEED —');
  text('canvas-resolution', '— × —');
  text('debug-edge', '—');
  text('debug-colors', '—');
}

function setup(result: ReferenceAnalysis, strokes: Stroke[] = [], finished = false) {
  analysis = result;
  engine.prepare(result, config(), strokes, finished, drawingFormat === 'legacy');
  resetManual();
  fitCanvas();
  text('seed-chip', `SEED ${result.seed}`);
  text('debug-edge', percent(result.strength));
  text('debug-colors', result.colors.toLocaleString());
  const scaled = result.width !== result.originalWidth || result.height !== result.originalHeight;
  text('canvas-resolution', `${result.width} × ${result.height}${scaled ? ' · scaled' : ''}`);
  if (scaled) toast(`Working at ${result.width} × ${result.height} for browser memory.`);
}

async function decode(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty image');
  return image;
}

function useReference(image: HTMLImageElement, dataUrl: string, name: string) {
  reference = { image, dataUrl, name };
  referenceImg.src = dataUrl;
  sourcePreview.classList.add('loaded');
  text('source-name', name);
  text('source-dimensions', `${image.naturalWidth} × ${image.naturalHeight}`);
  resetAnalysis();
  status('Reference loaded');
}

async function importImage(file: File) {
  if (!file.type.startsWith('image/')) return toast('Choose an image file such as PNG, JPEG, or WebP.');
  const id = ++loadId;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const image = await decode(dataUrl);
    if (id === loadId) useReference(image, dataUrl, file.name);
  } catch {
    if (id === loadId) toast('The browser could not open that image.');
  }
}

async function readReference(image: HTMLImageElement, dataUrl: string, settings: DrawingConfig) {
  const { width, height } = analysisSize(image.naturalWidth, image.naturalHeight);
  const straight = settings.fidelity === 'exact' && width === image.naturalWidth && height === image.naturalHeight
    ? await readStraightPng(dataUrl, width, height) : undefined;
  return analyzeReference(image, settings, straight);
}

function runAnalysis(begin = false) {
  if (!reference) return;
  const { image, dataUrl } = reference;
  const settings = config();
  const id = ++analysisId;
  start.disabled = true;
  analyze.disabled = true;
  analyze.textContent = 'Analyzing…';
  engine.pause();
  status('Reading reference colors and contours');
  window.setTimeout(async () => {
    if (id !== analysisId) return;
    try {
      const result = await readReference(image, dataUrl, settings);
      if (id !== analysisId) return;
      drawingFormat = 'live';
      setup(result);
      if (begin) engine.startFresh();
    } catch (error) {
      if (id !== analysisId) return;
      console.error(error);
      status('Analysis failed');
      toast('The reference could not be analyzed. Try a smaller image.');
    } finally {
      if (id === analysisId) {
        start.disabled = false;
        analyze.disabled = false;
        analyze.innerHTML = '<span class="spark-glyph">✦</span> Analyze reference';
      }
    }
  }, 25);
}

function changedSettings() {
  text('complexity-value', `${complexity.value}%`);
  text('edge-value', `${edge.value}%`);
  if (!reference) return;
  resetAnalysis();
  status('Settings updated · ready to start');
}

function newProject() {
  loadId++;
  reference = null;
  referenceImg.removeAttribute('src');
  sourcePreview.classList.remove('loaded');
  text('source-name', 'No source loaded');
  text('source-dimensions', '—');
  resetAnalysis();
  status('Ready for a reference');
}

interface Project {
  format: 'nthstroke';
  version: 1 | 2;
  metadata?: { title?: string; software?: string; modifiedAt?: string; strokeCount?: number };
  reference: { name: string; dataUrl: string };
  config?: Partial<DrawingConfig>;
  playbackPosition?: number;
  history?: Stroke[];
  finished?: boolean;
  legacy?: boolean;
  seed?: string;
  plan?: { strokes: Stroke[] };
}

function validateStrokes(strokes: Stroke[], width: number, height: number) {
  const coord = (p: { x: number; y: number } | undefined) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 4 && Math.abs(p.y) < 4;
  if (!Array.isArray(strokes) || strokes.length > 30000) throw new Error('Invalid history');
  let exact = false;
  for (const stroke of strokes) {
    if (!stroke || !stages.includes(stroke.stage) || !/^#[0-9a-f]{6}$/i.test(stroke.color)
      || !coord(stroke.start) || !coord(stroke.end) || !Array.isArray(stroke.path) || stroke.path.length < 2
      || stroke.path.length > 16384 || !stroke.path.every(coord) || !Array.isArray(stroke.pressure)
      || stroke.pressure.some((v) => !Number.isFinite(v) || v < 0 || v > 1) || !Number.isFinite(stroke.size)
      || stroke.size <= 0 || !Number.isFinite(stroke.velocity) || !Number.isFinite(stroke.opacity)) throw new Error('Invalid stroke');
    if (stroke.detail) {
      const { x, y, width: w, height: h, vertical, reverse } = stroke.detail;
      if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1
        || x + w > width || y + h > height || typeof vertical !== 'boolean' || typeof reverse !== 'boolean') {
        throw new Error('Invalid pixel stroke');
      }
      const track = stroke.detail.track;
      if (track !== undefined && (!Array.isArray(track) || track.length < 2 || track.length > 256 ||
          track.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.radius) ||
            p.x < 0.5 || p.y < 0.5 || p.x > width - 0.5 || p.y > height - 0.5 || p.radius <= 0 ||
            p.radius > Math.max(8, Math.ceil(Math.max(width, height) / 28))))) throw new Error('Invalid brush footprint');
      exact = true;
    } else if (exact) throw new Error('Invalid stroke order');
  }
}

function restoreControls(settings: Partial<DrawingConfig>) {
  const select = (field: HTMLSelectElement, value: string) => {
    if (Array.from(field.options).some((option) => option.value === value)) field.value = value;
  };
  select(style, settings.style ?? defaults.style);
  select(budget, String(settings.strokeBudget ?? defaults.strokeBudget));
  select(fidelity, settings.fidelity ?? 'exact');
  complexity.value = String(Math.round((settings.strokeComplexity ?? defaults.strokeComplexity) * 100));
  edge.value = String(Math.round((settings.edgePreservation ?? defaults.edgePreservation) * 100));
  text('complexity-value', `${complexity.value}%`);
  text('edge-value', `${edge.value}%`);
}

async function openProject(file: File) {
  const id = ++loadId;
  try {
    const payload = JSON.parse(await file.text()) as Project;
    if (payload.format !== 'nthstroke' || ![1, 2].includes(payload.version) || !payload.reference?.dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid project');
    }
    const legacy = payload.version === 1 || payload.legacy === true;
    const history = payload.version === 1 ? payload.plan?.strokes : payload.history;
    if (!history) throw new Error('Missing stroke history');
    const image = await decode(payload.reference.dataUrl);
    if (id !== loadId) return;
    const settings = { ...defaults, ...payload.config, fidelity: (legacy ? 'artistic' : payload.config?.fidelity ?? 'exact') as DrawingConfig['fidelity'] };
    const result = await readReference(image, payload.reference.dataUrl, settings);
    if (id !== loadId) return;
    validateStrokes(history, result.width, result.height);
    if (payload.seed && !legacy) result.seed = payload.seed;
    useReference(image, payload.reference.dataUrl, payload.reference.name || payload.metadata?.title || 'Recovered reference');
    restoreControls(settings);
    drawingFormat = legacy ? 'legacy' : 'live';
    setup(result, history, legacy || payload.finished === true);
    const position = Number(payload.playbackPosition);
    engine.seek(Number.isFinite(position) ? position : history.length);
    toast('Project opened with its recorded strokes.');
  } catch (error) {
    console.error(error);
    if (id === loadId) toast('That file could not be opened as an NTH Stroke project.');
  }
}

function download(blob: Blob, extension: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nth-stroke-${Date.now()}.${extension}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function exportProject() {
  if (!analysis || !reference) return toast('Analyze a reference before saving a project.');
  const payload: Project = {
    format: 'nthstroke', version: 2,
    metadata: { title: reference.name, software: 'NTH Stroke 0.3', modifiedAt: new Date().toISOString(), strokeCount: engine.strokes.length },
    reference: { name: reference.name, dataUrl: reference.dataUrl }, config: config(), seed: analysis.seed,
    playbackPosition: engine.snapshot().completed, history: [...engine.strokes], finished: engine.finished, legacy: engine.isLegacy,
  };
  download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'nthstroke');
}

async function exportRaster(type: 'png' | 'jpeg' | 'webp') {
  if (exporting) return;
  if (!engine.snapshot().completed && !engine.isRunning && !engine.finished && !manualHasInk) return toast('Draw before exporting artwork.');
  exporting = true;
  try {
    if (type === 'png' && engine.exactPixels && !manualHasInk) {
      download(await encodePng(engine.exactPixels), 'png');
      return;
    }
    const output = document.createElement('canvas');
    output.width = canvas.width;
    output.height = canvas.height;
    const ctx = output.getContext('2d')!;
    if (type === 'jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, output.width, output.height);
    }
    ctx.drawImage(canvas, 0, 0);
    ctx.drawImage(overlay, 0, 0, output.width, output.height);
    if (manualHasInk) ctx.drawImage(manual, 0, 0, output.width, output.height);
    const mime = `image/${type}`;
    const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, mime, 0.95));
    if (!blob) throw new Error('Image encoding failed');
    if (type === 'webp' && blob.type !== mime) toast('This browser exported PNG instead of WebP.');
    download(blob, blob.type === 'image/png' ? 'png' : type === 'jpeg' ? 'jpg' : 'webp');
  } catch (error) {
    console.error(error);
    toast('The image could not be exported.');
  } finally {
    exporting = false;
  }
}

function setManual(enabled: boolean) {
  manualMode = enabled;
  manual.classList.toggle('manual-input', enabled);
  $('#brush-tool').classList.toggle('active', enabled);
  $('#select-tool').classList.toggle('active', !enabled);
  if (enabled) engine.pause();
}

function drawManual(event: PointerEvent) {
  const bounds = manual.getBoundingClientRect();
  const point = {
    x: (event.clientX - bounds.left) * manual.width / bounds.width,
    y: (event.clientY - bounds.top) * manual.height / bounds.height,
  };
  const ctx = manual.getContext('2d')!;
  ctx.strokeStyle = '#241f1c';
  ctx.lineWidth = 1 + (event.pressure || 0.45) * 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(manualLast?.x ?? point.x, manualLast?.y ?? point.y);
  ctx.lineTo(point.x + 0.02, point.y);
  ctx.stroke();
  manualLast = point;
  manualHasInk = true;
  $('#canvas-empty-state').style.display = 'none';
}

engine.setUpdateHandler(render);
new ResizeObserver(fitCanvas).observe(stageContainer);
resetAnalysis();
status('Ready for a reference');
referenceInput.addEventListener('change', () => {
  const file = referenceInput.files?.[0];
  if (file) void importImage(file);
  referenceInput.value = '';
});
$('#drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); $('#drop-zone').classList.add('dragging'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('dragging'));
$('#drop-zone').addEventListener('drop', (event) => {
  event.preventDefault();
  $('#drop-zone').classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void importImage(file);
});
for (const field of [style, budget, fidelity]) field.addEventListener('change', changedSettings);
for (const field of [complexity, edge]) field.addEventListener('input', changedSettings);
analyze.addEventListener('click', () => runAnalysis());
start.addEventListener('click', () => {
  setManual(false);
  if (!analysis) return runAnalysis(true);
  resetManual();
  engine.startFresh();
});
play.addEventListener('click', () => {
  if (engine.isRunning) engine.pause();
  else { setManual(false); engine.play(); }
});
$('#stop-btn').addEventListener('click', () => engine.stop());
$('#rewind-btn').addEventListener('click', () => { engine.seek(0); engine.play(); });
$('#prev-btn').addEventListener('click', () => engine.step(-1));
$('#next-btn').addEventListener('click', () => engine.step(1));
timeline.addEventListener('input', () => engine.seek(Number(timeline.value)));
$<HTMLSelectElement>('#speed-select').addEventListener('change', (event) => engine.setSpeed(Number((event.target as HTMLSelectElement).value)));
$('#new-project-btn').addEventListener('click', newProject);
$('#open-project-btn').addEventListener('click', () => projectInput.click());
projectInput.addEventListener('change', () => {
  const file = projectInput.files?.[0];
  if (file) void openProject(file);
  projectInput.value = '';
});
for (const [id, delta] of [['zoom-in-btn', 0.1], ['zoom-out-btn', -0.1]] as const) {
  $(`#${id}`).addEventListener('click', () => {
    zoom = Math.max(0.5, Math.min(2.5, zoom + delta));
    frame.style.transform = `scale(${zoom})`;
    text('zoom-label', `${Math.round(zoom * 100)}%`);
  });
}
$('#grid-btn').addEventListener('click', () => $('#grid-overlay').classList.toggle('visible'));
$('#fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (stageContainer.requestFullscreen) {
    void stageContainer.requestFullscreen().catch(() => toast('Fullscreen is unavailable in this browser.'));
  } else toast('Fullscreen is unavailable in this browser.');
});
$('#reference-toggle-btn').addEventListener('click', () => {
  sourcePreview.classList.toggle('highlighted');
  $('#reference-toggle-btn').classList.toggle('active');
});
$('#brush-tool').addEventListener('click', () => setManual(!manualMode));
$('#select-tool').addEventListener('click', () => setManual(false));
manual.addEventListener('pointerdown', (event) => {
  if (!manualMode) return;
  manual.setPointerCapture(event.pointerId);
  drawManual(event);
});
manual.addEventListener('pointermove', (event) => { if (manualLast) drawManual(event); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) manual.addEventListener(event, () => { manualLast = null; });
for (const button of $$<HTMLButtonElement>('[data-export]')) {
  button.addEventListener('click', () => {
    const type = button.dataset.export;
    if (type === 'project') exportProject();
    else if (type === 'svg') {
      const strokes = engine.strokes.slice(0, engine.snapshot().completed);
      if (!strokes.some((stroke) => !stroke.detail)) return toast('Draw vector brushwork before exporting SVG.');
      download(new Blob([exportStrokeSvg(strokes, canvas.width, canvas.height, engine.isLegacy)], { type: 'image/svg+xml' }), 'svg');
    } else if (type === 'png' || type === 'jpeg' || type === 'webp') void exportRaster(type);
  });
}
