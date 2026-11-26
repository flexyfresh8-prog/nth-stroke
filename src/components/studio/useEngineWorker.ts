'use client';

/**
 * React hook that owns the engine worker lifecycle (spec §11, §13).
 * The canvas is transferred to the worker (OffscreenCanvas); the UI only
 * renders snapshots and sends commands.
 *
 * The worker is created lazily and kept for the lifetime of the page so
 * that React StrictMode remounts (dev) cannot orphan the canvas transfer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineSnapshot, InstrumentId, Stage, StylusSample } from '@/engine/core/types';
import type { EngineId } from '@/engine/control/contract';
import type { AdaptiveConfig } from '@/engine/adaptive/config';
import type { MapName } from '@/engine/adaptive/diagnostics';
import { readProjectFile, type NthProject } from '@/engine/session/exports';
import type { BenchmarkResult, FromWorker, PlaybackSpeed, ToWorker } from '@/engine/worker/protocol';

export interface SceneInfo {
  summary: string[];
  width: number;
  height: number;
  models: string[];
  seed: number;
}

export interface EngineWorkerState {
  ready: boolean;
  analysisPhase: string;
  analysisProgress: number;
  scene: SceneInfo | null;
  snapshot: EngineSnapshot | null;
  stage: Stage;
  stageReason?: string;
  corrections: Array<{ reason: string; t: number }>;
  error: string | null;
  speed: PlaybackSpeed;
  timelapseActive: boolean;
  diagnostics: Extract<FromWorker,{type:'diagnostic'}>|null;
  benchmarkStatus:string;
  benchmark:BenchmarkResult[];
}

export function useEngineWorker() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const usePatchTransport = useRef(false);
  useEffect(()=>()=>{workerRef.current?.terminate();workerRef.current=null;},[]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [state, setState] = useState<EngineWorkerState>({
    ready: false,
    analysisPhase: '',
    analysisProgress: 0,
    scene: null,
    snapshot: null,
    stage: 'observation',
    corrections: [],
    error: null,
    speed: 1,
    timelapseActive: false, diagnostics:null, benchmarkStatus:'', benchmark:[],
  });

  /** Lazily create the singleton worker with its message handler. */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('../../engine/worker/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      setState((prev) => {
        switch (msg.type) {
          case 'ready':
            return { ...prev, ready: true, error: null };
          case 'analysis':
            return { ...prev, analysisPhase: msg.phase, analysisProgress: msg.progress };
          case 'scene':
            return {
              ...prev,
              scene: { summary: msg.summary, width: msg.width, height: msg.height, models: msg.models, seed: msg.seed },
              analysisProgress: 1,
              analysisPhase: '',
            };
          case 'snapshot':
            return { ...prev, snapshot: msg.data, stage: msg.data.stage };
          case 'stage':
            return { ...prev, stage: msg.stage, stageReason: msg.reason };
          case 'correction':
            return { ...prev, corrections: [...prev.corrections.slice(-79), { reason: msg.reason, t: msg.t }] };
          case 'restored':
            return { ...prev, corrections: [] };
          case 'error':
            return { ...prev, error: msg.message, analysisPhase:'', benchmarkStatus:'' };
          case 'diagnostic': return {...prev,diagnostics:msg};
          case 'benchmark-status': return {...prev,benchmarkStatus:msg.value};
          case 'benchmark-result': return {...prev,benchmark:msg.results,benchmarkStatus:''};
          default:
            return prev;
        }
      });
      if(msg.type==='patch'){
        const canvas=canvasRef.current;
        if(canvas){
          if(canvas.width!==msg.width)canvas.width=msg.width;
          if(canvas.height!==msg.height)canvas.height=msg.height;
          canvas.getContext('2d')?.putImageData(msg.image,msg.x,msg.y);
        }
      }
      if(msg.type==='capture'){
        canvasRef.current?.toBlob(blob=>{if(blob)download(blob,msg.filename);},
          msg.kind==='jpeg'?'image/jpeg':`image/${msg.kind}`,msg.quality);
      }
      if (msg.type==='export-result'&&msg.blob)download(msg.blob,msg.filename);
    });
    worker.addEventListener('error',event=>setState(prev=>({...prev,error:event.message||'Drawing worker failed.',analysisPhase:'',benchmarkStatus:''})));
    workerRef.current = worker;
    return worker;
  }, []);

  const send = useCallback((message: ToWorker, transfer?: Transferable[]) => {
    const worker = workerRef.current ?? ensureWorker();
    worker.postMessage(message, transfer ?? []);
  }, [ensureWorker]);

  /** Ref callback for the canvas — transfers control once per canvas element. */
  const attachCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (!canvas) return;
      if(workerRef.current)return;
      const worker=ensureWorker();
      let off:OffscreenCanvas|undefined;
      try {
        if(typeof canvas.transferControlToOffscreen==='function'&&typeof OffscreenCanvas!=='undefined'){
          const probe=new OffscreenCanvas(1,1);
          if(probe.getContext('2d'))off=canvas.transferControlToOffscreen();
        }
      }catch{ /* fall back to bitmap patches */ }
      usePatchTransport.current=!off;
      if(!off){
        const context=canvas.getContext('2d');
        if(context){context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);}
      }
      worker.postMessage({type:'init',canvas:off,width:canvas.width,height:canvas.height,
        basePath:process.env.NEXT_PUBLIC_BASE_PATH??''},off?[off]:[]);
    },
    [ensureWorker],
  );

  const beginLoad=useCallback(()=>{
    const id=++sequence.current;
    send({type:'cancel'});
    send({type:'stop-benchmark'});
    setState(prev=>({...prev,analysisPhase:'Decoding reference',scene:null,snapshot:null,corrections:[],
      analysisProgress:.03,diagnostics:null,benchmark:[],benchmarkStatus:'',error:null,stage:'observation'}));
    return id;
  },[send]);

  const loadReference=useCallback(async(file:File,options:Partial<AdaptiveConfig>,engine:EngineId)=>{
    const id=beginLoad();
    try{
      const bitmap=await createImageBitmap(file);
      if(id!==sequence.current){bitmap.close();return;}
      const performanceMode=options.adaptive?.performance??'auto';
      const memory=(navigator as Navigator & {deviceMemory?:number}).deviceMemory;
      const compact=performanceMode==='compact'||(performanceMode==='auto'&&((memory!==undefined&&memory<=2)||navigator.hardwareConcurrency<=2));
      const max=engine==='v2'?(compact?300:384):512;
      const packed = usePatchTransport.current ? analysisPixels(bitmap,engine,max) : undefined;
      const dataUrl=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);
      });
      if(id!==sequence.current){bitmap.close();return;}
      send({type:'load',id,bitmap,pixels:packed,engine,analysisMax:max,config:options,referenceDataUrl:dataUrl,
        referenceWidth:bitmap.width,referenceHeight:bitmap.height},[bitmap]);
    }catch(error){
      if(id===sequence.current)setState(p=>({...p,error:error instanceof Error?error.message:'Could not decode the image.',analysisPhase:''}));
    }
  },[beginLoad,send]);

  const start = useCallback(() => send({ type: 'start' }), [send]);
  const pause = useCallback(() => send({ type: 'pause' }), [send]);
  const resume = useCallback(() => send({ type: 'resume' }), [send]);
  const cancel = useCallback(() => send({ type: 'cancel' }), [send]);
  const restart = useCallback(() => send({ type: 'restart' }), [send]);
  const setSpeed = useCallback((value: PlaybackSpeed) => {
    send({ type: 'speed', value });
    setState((p) => ({ ...p, speed: value }));
  }, [send]);
  const userStroke = useCallback((samples: StylusSample[], instrument: InstrumentId) => send({ type: 'user-stroke', samples, instrument }), [send]);
  const requestExport = useCallback((kind: 'svg' | 'png' | 'jpeg' | 'webp' | 'session' | 'project') => send({ type: 'export', kind }), [send]);
  const requestCheckpoint = useCallback(() => send({ type: 'checkpoint' }), [send]);

  const restoreProject=useCallback(async(file:File,onProject:(project:NthProject,engine:EngineId,reference:File)=>void)=>{
    const id=beginLoad();
    try{
      const project=await readProjectFile(file);
      if(project.format!=='nth-project'||!project.reference?.dataUrl?.startsWith('data:image/')||!project.checkpoint)throw new Error('This file is not a supported .nth project.');
      const engine=project.engineVersion?.startsWith('2.')?'v2':'v1';
      const response=await fetch(project.reference.dataUrl);
      const blob=await response.blob();
      const ref=new File([blob],'Project reference',{type:blob.type});
      const bitmap=await createImageBitmap(blob);
      if(id!==sequence.current){bitmap.close();return;}
      const pixels=usePatchTransport.current?analysisPixels(bitmap,engine,engine==='v2'?384:512,engine==='v2'?project.canvas:undefined):undefined;
      onProject(project,engine,ref);
      send({type:'restore',id,project,bitmap,pixels,engine},[bitmap]);
    }catch(error){
      if(id===sequence.current)setState(p=>({...p,error:error instanceof Error?error.message:'Could not open the project.',analysisPhase:''}));
    }
  },[beginLoad,send]);
  const replay=useCallback(()=>send({type:'replay'}),[send]);
  const refine=useCallback(()=>send({type:'refine'}),[send]);
  const seek=useCallback((position:number)=>send({type:'seek',position}),[send]);
  const inspect=useCallback((view:MapName)=>send({type:'diagnostic',view}),[send]);
  const compare=useCallback((budget:number,config:Partial<AdaptiveConfig>)=>{
    setState(p=>({...p,benchmark:[],benchmarkStatus:'Preparing comparison'}));
    send({type:'benchmark',budget,config});
  },[send]);
  const stopBenchmark=useCallback(()=>send({type:'stop-benchmark'}),[send]);

  /** Timelapse recording via MediaRecorder on the visible canvas. */
  const toggleTimelapse = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
      setState((prev) => ({ ...prev, timelapseActive: false }));
      return;
    }
    try {
      const stream = canvas.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      if (!mime) {
        setState((prev) => ({ ...prev, error: 'Timelapse recording is not supported in this browser.' }));
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = mime.startsWith('video/mp4') ? 'nth-stroke-timelapse.mp4' : 'nth-stroke-timelapse.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      };
      recorder.start(500);
      recorderRef.current = recorder;
      setState((prev) => ({ ...prev, timelapseActive: true }));
    } catch {
      setState((prev) => ({ ...prev, error: 'Timelapse recording could not be started.' }));
    }
  }, []);

  return {
    state,
    canvasRef,
    attachCanvas,
    loadReference,
    start,
    pause,
    resume,
    cancel,
    restart,
    setSpeed,
    userStroke,
    requestExport,
    requestCheckpoint,
    restoreProject,
    toggleTimelapse,replay,refine,seek,inspect,compare,stopBenchmark,
  };
}

function analysisPixels(bitmap:ImageBitmap,engine:EngineId,limit:number,size?:{width:number;height:number}){
  const scale=Math.min(1,limit/Math.max(bitmap.width,bitmap.height));
  const minimum=engine==='v2'?1:8,canvas=document.createElement('canvas');
  canvas.width=size?.width??Math.max(minimum,Math.round(bitmap.width*scale));canvas.height=size?.height??Math.max(minimum,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  context.imageSmoothingQuality='high';context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  return context.getImageData(0,0,canvas.width,canvas.height);
}

function download(blob:Blob,filename:string) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
