/**
 * The engine worker: owns the transferred OffscreenCanvas, the analysis
 * pipeline, the MediaPipe models and the DrawingController (spec §14).
 * The UI stays responsive — planning, deposition physics and evaluation
 * all run here; only lightweight snapshots cross the boundary.
 */

import { analyzeScene, type SceneGraph } from '../analysis/scene';
import { AdaptiveController } from '../adaptive/controller';
import { observe, type Field } from '../adaptive/perception';
import { diagnostic } from '../adaptive/diagnostics';
import { benchmark } from '../adaptive/benchmark';
import type { AdaptiveConfig } from '../adaptive/config';
import type { DrawingRuntime, EngineId } from '../control/contract';
import { DrawingController } from '../control/controller';
import { DEFAULT_CONFIG, ENGINE_VERSION, type InstrumentId, type StylusSample } from '../core/types';
import { BrowserMlProvider } from '../ml/browser';
import { NullMlProvider, type MlProvider, type FaceObservation, type PoseObservation, type SegmentationObservation } from '../ml/provider';
import { buildProjectFile, exportSessionJson, exportSvg, type NthProject } from '../session/exports';
import type { FromWorker, PlaybackSpeed, ToWorker } from './protocol';

const ANALYSIS_MAX = 512;
const CANVAS_MAX = 1280;

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let controller: DrawingRuntime | null = null;
let adaptiveField: Field | null = null;
let engine: EngineId = 'v2';
let loadId = 0;
let benchmarkId = 0;
let seekTimer: ReturnType<typeof setTimeout> | undefined;
let benchmarkSource: { rgba:Uint8ClampedArray; width:number; height:number }|null = null;
let scene: SceneGraph | null = null;
let provider: MlProvider = new NullMlProvider();
let modelsLoaded: string[] = [];
let basePath = '';
let speed: PlaybackSpeed = 1;
let running = false;
let simTarget = 0;
let lastTick = 0;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let frameImageData: ImageData | null = null;
let pendingRects: Array<{ x: number; y: number; w: number; h: number }> = [];
let lastSnapshotPost = 0;
let loadMeta: { dataUrl: string; width: number; height: number } | null = null;
let engineConfig: AdaptiveConfig = { ...DEFAULT_CONFIG };

const workerSelf = self as unknown as {
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const post = (message: FromWorker, transfer?: Transferable[]) =>
  transfer ? workerSelf.postMessage(message, transfer) : workerSelf.postMessage(message);

function analysisSize(w: number, h: number, id: EngineId, max=384) {
  const scale=Math.min(1,(id==='v2'?max:ANALYSIS_MAX)/Math.max(w,h));
  const minimum=id==='v2'?1:8;
  return {width:Math.max(minimum,Math.round(w*scale)),height:Math.max(minimum,Math.round(h*scale))};
}

function canvasSize(w: number, h: number) {
  const scale = Math.min(1, CANVAS_MAX / Math.max(w, h));
  return { width: Math.max(320, Math.round(w * scale)), height: Math.max(240, Math.round(h * scale)) };
}

function rgbaFromBitmap(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, width, height);
  return g.getImageData(0, 0, width, height).data;
}

function composite(rects: Array<{ x: number; y: number; w: number; h: number }>) {
  if (!controller) return;
  // Coalesce into a few bounding boxes for cheap putImageData calls.
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const r of rects) {
    const merged = boxes.find(
      (b) =>
        r.x >= b.x - 48 && r.y >= b.y - 48 &&
        r.x + r.w <= b.x + b.w + 48 && r.y + r.h <= b.y + b.h + 48,
    );
    if (merged) {
      const x2 = Math.max(merged.x + merged.w, r.x + r.w);
      const y2 = Math.max(merged.y + merged.h, r.y + r.h);
      merged.x = Math.min(merged.x, r.x);
      merged.y = Math.min(merged.y, r.y);
      merged.w = x2 - merged.x;
      merged.h = y2 - merged.y;
    } else {
      boxes.push({ ...r });
    }
  }
  const map = controller.map;
  const paper = controller.paper;
  for (const box of boxes) {
    const x = Math.max(0, Math.min(map.width - 1, Math.floor(box.x)));
    const y = Math.max(0, Math.min(map.height - 1, Math.floor(box.y)));
    const w = Math.max(1, Math.min(map.width - x, Math.ceil(box.w + (box.x - x))));
    const h = Math.max(1, Math.min(map.height - y, Math.ceil(box.h + (box.y - y))));
    if (!frameImageData || frameImageData.width !== w || frameImageData.height !== h) {
      frameImageData = new ImageData(w, h);
    }
    map.compositeRect(paper.albedo, frameImageData.data, { x, y, w, h }, { width: map.width, height: map.height }, w);
    // The tile image is w×h: place it at (x, y).
    if (ctx) ctx.putImageData(frameImageData, x, y);
    else {
      post({type:'patch',image:frameImageData,x,y,width:map.width,height:map.height},[frameImageData.data.buffer]);
      frameImageData=null;
    }
  }
}

function buildController(config: Partial<AdaptiveConfig>, seed: number) {
  if (!scene&&!adaptiveField) return;
  engineConfig = { ...DEFAULT_CONFIG, ...config, seed };
  const callbacks: ConstructorParameters<typeof DrawingController>[2] = {
    onDirty: (rects) => {
      pendingRects.push(...rects);
    },
    onSnapshot: (s) => {
      const now = performance.now();
      if (now - lastSnapshotPost > 90 || s.done) {
        lastSnapshotPost = now;
        post({ type: 'snapshot', data: s });
      }
    },
    onStage: (stage, reason) => post({ type: 'stage', stage, reason }),
    onCorrection: (reason) => post({ type: 'correction', reason, t: controller?.simTime ?? 0 }),
  };
  controller=engine==='v2'?new AdaptiveController(adaptiveField!,engineConfig,callbacks):new DrawingController(scene,engineConfig,callbacks);
}

function tick() {
  if (!controller) return;
  try {
    const now = performance.now();
    const dt = Math.min(100, now - (lastTick || now));
    lastTick = now;
    if (running && controller.running) {
      if (speed === 'max') {
        controller.runOps(64, 12);
      } else {
        simTarget = Math.min(controller.simTime + dt * speed, controller.simTime + 3200 * speed);
        controller.advance(simTarget);
      }
      if (controller.userEditedSinceEval && !controller.busy) controller.evaluate();
    }
    if (pendingRects.length) {
      composite(pendingRects);
      pendingRects = [];
    }
    const snap = controller.snapshot();
    const t = performance.now();
    if (running && t - lastSnapshotPost > 90) {
      lastSnapshotPost = t;
      post({ type: 'snapshot', data: snap });
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: `engine loop failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
  }
}

async function loadReference(message: Extract<ToWorker, { type: 'load' }>, canvasOverride?: {width:number;height:number}, restoredField?: Field['landmarks']) {
  const id=message.id;
  clearTimeout(seekTimer);
  loadId=id; benchmarkId++;
  running=false; controller?.cancel(); controller=null; scene=null; adaptiveField=null; benchmarkSource=null;
  pendingRects=[]; lastSnapshotPost=0;
  post({ type:'analysis',phase:'Decoding reference',progress:.05 });
  const bitmap=message.bitmap;
  let rgba:Uint8ClampedArray, width:number, height:number;
  try {
    const analysis=message.pixels??null;
    const a=message.engine==='v2'&&canvasOverride?canvasOverride:analysis??analysisSize(bitmap.width,bitmap.height,message.engine,message.analysisMax);
    width=a.width;height=a.height;
    rgba=analysis?.data??rgbaFromBitmap(bitmap,width,height);
    const canModel=typeof OffscreenCanvas!=='undefined'&&message.config.useModels!==false&&!restoredField;
    let face: FaceObservation|null=null, pose:PoseObservation|null=null, segmentation:SegmentationObservation|null=null;
    if(canModel){
      post({type:'analysis',phase:'Reading local vision features',progress:.45});
      if(provider instanceof BrowserMlProvider)await provider.ensureLoaded(message.engine==='v2'?'face':'all');
      else await provider.ensureLoaded?.();
      if(id!==loadId)return false;
      const source=new OffscreenCanvas(width,height);
      source.getContext('2d')!.drawImage(bitmap,0,0,width,height);
      face=await provider.face(source);
      if(message.engine==='v1'){
        pose=await provider.pose(source);
        segmentation=await provider.segment(source,width,height);
      }
    }
    if(id!==loadId)return false;
    post({type:'analysis',phase:'Building tonal and structural fields',progress:.82});
    engine=message.engine;
    const size=canvasOverride??(engine==='v2'?{width,height}:canvasSize(message.referenceWidth,message.referenceHeight));
    const observations=restoredField??undefined;
    if(engine==='v2'){
      adaptiveField=observe(rgba,width,height,face,observations);
    }else{
      scene=analyzeScene({rgba,width,height,canvasWidth:size.width,canvasHeight:size.height,face,pose,segmentation});
    }
    benchmarkSource={rgba,width,height};
    loadMeta={dataUrl:message.referenceDataUrl,width:message.referenceWidth,height:message.referenceHeight};
    if(ctx){ctx.canvas.width=size.width;ctx.canvas.height=size.height;frameImageData=null;}
    buildController(message.config,message.config.seed??DEFAULT_CONFIG.seed);
    simTarget=0;
    composite([{x:0,y:0,w:size.width,h:size.height}]);
    post({type:'scene',summary:scene?.summary??[
      adaptiveField!.kind==='line'?'Line-focused':adaptiveField!.kind==='tone'?'Tone-focused':adaptiveField!.kind==='portrait'?'Portrait-focused':'Scene-focused',
      `${adaptiveField!.contours.length} connected contours`
    ], width:size.width,height:size.height,models:engine==='v2'?(face||restoredField?.length?['face']:[]):canModel?modelsLoaded:[],seed:engineConfig.seed});
    post({type:'snapshot',data:currentController()!.snapshot()});
    return true;
  }finally{bitmap.close();}
}

function currentController(){return controller;}

function exportName(kind: string, ext: string) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return `nth-stroke-${stamp}-${kind}.${ext}`;
}

workerSelf.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init': {
        basePath = message.basePath;
        const canvas = message.canvas;
        ctx = canvas?.getContext('2d', { alpha: false }) ?? null;
        if(canvas){canvas.width=message.width;canvas.height=message.height;}
        if(ctx){ctx.fillStyle='#fff';ctx.fillRect(0,0,message.width,message.height);}
        if (loopTimer !== null) clearInterval(loopTimer);
        provider = new BrowserMlProvider(basePath, (status) => {
          if (status.startsWith('vision models ready')) {
            modelsLoaded = status.match(/\((\d)\/3\)/)?.[1] === '3'
              ? ['face', 'pose', 'segmentation']
              : status.includes('unavailable')
                ? []
                : modelsLoaded;
          }
        });
        lastTick = performance.now();
        loopTimer = setInterval(tick, 16);
        post({ type: 'ready' });
        break;
      }
      case 'load': {
        running = false;
        if (controller) controller.cancel();
        await loadReference(message);
        break;
      }
      case 'start': {
        if (!controller) break;
        simTarget = controller.simTime;
        controller.start();
        running = controller.running;
        break;
      }
      case 'pause': {
        controller?.pause();
        running = false;
        if (controller) post({ type: 'snapshot', data: controller.snapshot() });
        break;
      }
      case 'resume': {
        clearTimeout(seekTimer);
        if (!controller) break;
        simTarget = controller.simTime;
        controller.resume();
        running = controller.running;
        break;
      }
      case 'cancel': {
        loadId++;
        controller?.cancel();
        running = false;
        if(controller)post({type:'snapshot',data:controller.snapshot()});
        break;
      }
      case 'restart': {
        if ((!scene && !adaptiveField) || !controller) break;
        running = false;
        controller.cancel();
        buildController(engineConfig, engineConfig.seed);
        simTarget = 0;
        pendingRects = [{ x: 0, y: 0, w: controller.map.width, h: controller.map.height }];
        composite(pendingRects);
        pendingRects = [];
        post({ type: 'snapshot', data: controller.snapshot() });
        break;
      }
      case 'speed': {
        speed = message.value;
        if (controller) simTarget = controller.simTime;
        break;
      }
      case 'user-stroke': {
        if (controller) {
          controller.injectUserStroke(message.samples as StylusSample[], message.instrument as InstrumentId);
        }
        break;
      }
      case 'export': {
        if (!controller) break;
        if (message.kind === 'png' || message.kind === 'jpeg' || message.kind === 'webp') {
          composite([{ x: 0, y: 0, w: controller.map.width, h: controller.map.height }]);
          const type = message.kind === 'png' ? 'image/png' : message.kind === 'jpeg' ? 'image/jpeg' : 'image/webp';
          const filename=exportName('drawing',message.kind);
          if(ctx){
            const blob=await ctx.canvas.convertToBlob({type, quality:message.quality??.92});
            post({type:'export-result',kind:message.kind,blob,filename});
          }else post({type:'capture',kind:message.kind,filename,quality:message.quality});
        } else if (message.kind === 'svg') {
          const result = exportSvg(controller.session, controller.map.width, controller.map.height, {
            seed:controller.config.seed,
            adaptive:controller instanceof AdaptiveController?controller.historyForExport().map(r=>r.mark):undefined,
          });
          const blob = new Blob([result.svg], { type: 'image/svg+xml' });
          post({ type: 'export-result', kind: 'svg', blob, filename: exportName('drawing', 'svg'), text: JSON.stringify({ pathCount: result.pathCount, byteSize: result.byteSize, skippedBlendOps: result.skippedBlendOps }) });
        } else if (message.kind === 'session') {
          const json = exportSessionJson(controller.session);
          const blob = new Blob([json], { type: 'application/json' });
          post({ type: 'export-result', kind: 'session', blob, filename: exportName('session', 'json') });
        } else if (message.kind === 'project') {
          if (!loadMeta) break;
          const blob = await buildProjectFile(
            controller.session,
            controller.checkpoint(),
            controller.config,
            controller.config.seed,
            loadMeta.dataUrl,
            loadMeta.width,
            loadMeta.height,
            controller.map.width,
            controller.map.height,
            engine==='v2'?'2.0.0':ENGINE_VERSION,
          );
          post({ type: 'export-result', kind: 'project', blob, filename: exportName('project', 'nth') });
        }
        break;
      }
      case 'checkpoint': {
        if (!controller) break;
        post({ type: 'export-result', kind: 'checkpoint', text: JSON.stringify(controller.checkpoint()), filename: 'checkpoint.json' });
        break;
      }
      case 'replay': {
        clearTimeout(seekTimer);
        if(controller instanceof AdaptiveController){controller.replay();running=controller.running;}
        break;
      }
      case 'refine': {
        clearTimeout(seekTimer);
        if(controller instanceof AdaptiveController){controller.refine();running=controller.running;}
        break;
      }
      case 'seek': {
        if(controller instanceof AdaptiveController){
          running=false;const current=controller;
          clearTimeout(seekTimer);
          seekTimer=setTimeout(()=>{
            if(current===controller){current.seek(message.position);post({type:'snapshot',data:current.snapshot()});}
          },65);
        }
        break;
      }
      case 'diagnostic': {
        if(controller instanceof AdaptiveController){
          const result=diagnostic(controller,message.view), info=controller.diagnostics();
          post({type:'diagnostic',view:message.view,...result,info:{...info,trials:info.trials.map(t=>({gain:t.gain,instrument:t.mark.instrument}))}},[result.rgba.buffer]);
        }
        break;
      }
      case 'benchmark': {
        if(!benchmarkSource)break;
        controller?.pause();running=false;
        if(controller)post({type:'snapshot',data:controller.snapshot()});
        const request=++benchmarkId,source=benchmarkSource;
        post({type:'benchmark-status',value:'Running V1 and V2 sequentially'});
        const results=await benchmark(source.rgba,source.width,source.height,message.config,message.budget,()=>request===benchmarkId,
          value=>post({type:'benchmark-status',value}));
        if(request===benchmarkId)post({type:'benchmark-result',results});
        break;
      }
      case 'stop-benchmark': {
        benchmarkId++;post({type:'benchmark-status',value:''});break;
      }
      case 'restore': {
        const project=message.project as NthProject;
        const checkpoint=project.checkpoint;
        const adaptive=message.engine==='v2'?checkpoint as ReturnType<AdaptiveController['checkpoint']>:null;
        const restored=await loadReference({
          type:'load', id:message.id, engine:message.engine,bitmap:message.bitmap,pixels:message.pixels,
          config:{...(project.config as Partial<AdaptiveConfig>),seed:project.seed},referenceDataUrl:project.reference.dataUrl,
          referenceWidth:project.reference.width,referenceHeight:project.reference.height,
        },project.canvas,adaptive?.landmarks);
        const runtime=currentController();
        if(restored&&runtime&&loadId===message.id){
          if(runtime instanceof AdaptiveController)runtime.restore(adaptive!);
          else if(runtime instanceof DrawingController)runtime.restore(checkpoint as Parameters<DrawingController['restore']>[0]);
          runtime.session.restore(project.session);
          post({type:'restored',summary:['Session restored']});
          post({type:'snapshot',data:runtime.snapshot()});
        }
        break;
      }
    }
  } catch (err) {
    if ((message.type!=='load'&&message.type!=='restore')||message.id===loadId) post({type:'error',message:err instanceof Error?err.message:String(err)});
  }
};

void ENGINE_VERSION;
