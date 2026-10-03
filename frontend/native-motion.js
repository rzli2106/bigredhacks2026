import {SensorPipeline} from '../src/sensor-pipeline.js';

/** Native samples use browser-compatible units; only gated candidates leave this service. */
export class NativeMotionService {
  constructor({bridge,config,onCandidate=()=>{},onSamples=()=>{},onStatus=()=>{},document=globalThis.document}) {
    Object.assign(this,{bridge,onCandidate,onSamples,onStatus,document});
    this.pipeline=new SensorPipeline(config);this.generation=0;this.running=false;
    this.visibility=()=>this.pipeline.reset();this.pending=Promise.resolve();
  }
  start() {
    if(this.running||this.starting)return this.pending;
    const generation=++this.generation;this.starting=true;
    // Serialize native starts/stops so a late start result cannot restart sharing.
    this.pending=this.pending.catch(()=>{}).then(async()=>{
      if(generation!==this.generation)return;
      let listener;
      try {
        listener=await this.bridge.addListener('motionSample',sample=>{
          if(!this.running||generation!==this.generation||this.document?.hidden)return;
          const result=this.pipeline.push(sample);
          if(result.droppedReason)this.onStatus({state:'sample-dropped',reason:result.droppedReason});
          if(result.samples.length)this.onSamples(result.samples);
          for(const candidate of result.candidates)this.onCandidate(candidate);
        });
        if(generation!==this.generation){await listener.remove();return;}
        this.pipeline.reset();await this.bridge.startMotion();
        if(generation!==this.generation){await this.release(listener);return;}
        this.listener=listener;this.running=true;
        this.document?.addEventListener('visibilitychange',this.visibility);
        this.onStatus({state:'listening'});
      } catch(error) {await this.release(listener).catch(()=>{});throw error;}
      finally {if(generation===this.generation)this.starting=false;}
    });
    return this.pending;
  }
  async release(listener) {
    // Neither a native stop failure nor a listener failure may skip the other cleanup.
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>this.bridge.stopMotion()),
      Promise.resolve().then(()=>listener?.remove()),
    ]);
    const failed=results.find(result=>result.status==='rejected');
    if(failed)throw failed.reason;
  }
  stop() {
    ++this.generation;this.running=false;this.starting=false;this.pipeline.reset();
    this.document?.removeEventListener('visibilitychange',this.visibility);
    const listener=this.listener;this.listener=null;
    this.pending=this.pending.catch(()=>{}).then(()=>this.release(listener)).catch(error=>this.onStatus({state:'error',reason:error.message}));
    this.onStatus({state:'stopped'});return this.pending;
  }
}
