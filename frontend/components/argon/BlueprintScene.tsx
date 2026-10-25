'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { SceneViewerProps, Vec3 } from '@/lib/contracts';
import { buildBlueprintGeometry } from '@/lib/blueprint-geometry';
import type { AppBase, Entity } from 'playcanvas';

type Props = SceneViewerProps & { zoom: number; rotation: number };
type Runtime = { app: AppBase; camera: Entity; update: () => void; reset: () => void };

export default function BlueprintScene({ snapshot, selectedRoomId, selectedFindingId, onSelectFinding, heatmap = false, showMarkers = true, showPath = true, viewMode, zoom, rotation }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const labels = useRef(new Map<string, HTMLDivElement | HTMLButtonElement>());
  const controls = useRef({ yaw: rotation + 1.4, pitch: 0.83, zoom, panX: 0, panZ: 0 });
  const currentView = useRef(viewMode);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const hasRooms = snapshot.blueprint.rooms.length > 0;
  const geometryKey = JSON.stringify({ model: snapshot.blueprint, heatmap, selectedRoomId, findings: snapshot.findings.map(f => [f.id,f.status,f.roomId]), checks: heatmap ? snapshot.checklist.map(c => [c.roomId,c.status]) : [] });
  const annotationKey = JSON.stringify({ findings: snapshot.findings.map(f => [f.id,f.anchor,f.status]), path: showPath ? snapshot.path : [], showMarkers });

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    controls.current.zoom = zoom; controls.current.yaw = rotation + 1.4;
    currentView.current = viewMode;
    runtime.current?.update();
  }, [zoom, rotation, viewMode]);
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => runtime.current?.update());
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  useEffect(() => {
    const element = host.current;
    if (!element || !hasRooms || !visible) return;
    let cancelled = false, app: AppBase | null = null;
    let cleanup = () => {};
    setReady(false); setError(null);
    void (async () => {
      try {
        const { AppBase, AppOptions, CameraComponentSystem, RenderComponentSystem, LightComponentSystem, createGraphicsDevice, DEVICETYPE_WEBGL2, Entity, Color, PROJECTION_ORTHOGRAPHIC, StandardMaterial, CULLFACE_NONE, BLEND_NORMAL, Mesh, MeshInstance, PRIMITIVE_TRIANGLES, PRIMITIVE_LINES, Vec3, RESOLUTION_FIXED } = await import('playcanvas');
        const pc = { AppBase, AppOptions, CameraComponentSystem, RenderComponentSystem, LightComponentSystem, createGraphicsDevice, DEVICETYPE_WEBGL2, Entity, Color, PROJECTION_ORTHOGRAPHIC, StandardMaterial, CULLFACE_NONE, BLEND_NORMAL, Mesh, MeshInstance, PRIMITIVE_TRIANGLES, PRIMITIVE_LINES, Vec3, RESOLUTION_FIXED };
        if (cancelled) return;
        const data = buildBlueprintGeometry(snapshot, heatmap, selectedRoomId);
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
        element.prepend(canvas);
        const device = await pc.createGraphicsDevice(canvas, { deviceTypes: [pc.DEVICETYPE_WEBGL2], antialias: true, alpha: false, powerPreference: 'low-power' });
        if (cancelled) { device.destroy(); canvas.remove(); return; }
        app = new pc.AppBase(canvas);
        const options = new pc.AppOptions();
        options.graphicsDevice = device;
        options.componentSystems = [pc.CameraComponentSystem,pc.RenderComponentSystem,pc.LightComponentSystem];
        options.resourceHandlers = []; options.devtools = false;
        app.init(options);
        const ownApp = app;
        ownApp.autoRender = false;
        ownApp.scene.ambientLight = new pc.Color(0.42,0.57,0.76);
        const camera = new pc.Entity('Auditgon blueprint camera');
        camera.addComponent('camera', { clearColor: new pc.Color(0.025,0.11,0.22), projection: pc.PROJECTION_ORTHOGRAPHIC, nearClip: data.extent * 0.001, farClip: data.extent * 30 });
        ownApp.root.addChild(camera);
        const light = new pc.Entity('Architectural light');
        light.addComponent('light', { type: 'directional', color: new pc.Color(0.78,0.9,1), intensity: 1.1, castShadows: false });
        light.setEulerAngles(48,32,0); ownApp.root.addChild(light);
        const resources: { destroy: () => void }[] = [];
        const material = (hex: string, unlit = false, opacity = 1) => {
          const mat = new pc.StandardMaterial();
          const color = new pc.Color().fromString(hex);
          mat.diffuse = color; mat.useMetalness = false; mat.gloss = 12; mat.cull = pc.CULLFACE_NONE;
          if (unlit) { mat.useLighting = false; mat.emissive = color; mat.diffuse = new pc.Color(0,0,0); }
          mat.opacity = opacity;
          if (opacity < 1) { mat.blendType = pc.BLEND_NORMAL; mat.depthWrite = false; }
          mat.update(); resources.push(mat); return mat;
        };
        const addMesh = (positions: number[], indices: number[] | null, normals: number[] | null, mat: ReturnType<typeof material>, primitive: number = pc.PRIMITIVE_TRIANGLES) => {
          if (!positions.length) return;
          const mesh = new pc.Mesh(ownApp.graphicsDevice);
          mesh.setPositions(positions);
          if (indices) mesh.setIndices(indices);
          if (normals) mesh.setNormals(normals);
          mesh.update(primitive);
          const node = new pc.Entity('Blueprint geometry');
          node.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh,mat,node)] });
          ownApp.root.addChild(node); resources.push(mesh);
        };
        for (const [color,batch] of data.batches) addMesh(batch.positions,batch.indices,batch.normals,material(color));
        addMesh(data.grid,null,null,material('#3c719f',true,0.34),pc.PRIMITIVE_LINES);
        addMesh(data.edges,null,null,material('#f0f8ff',true),pc.PRIMITIVE_LINES);
        if (showPath && snapshot.path.length > 1) {
          const path:number[]=[];
          snapshot.path.slice(-400).forEach((p,i,all)=>{if(i)path.push(...all[i-1],...p);});
          addMesh(path,null,null,material('#d0e99a',true),pc.PRIMITIVE_LINES);
        }
        const markers = [
          ...snapshot.blueprint.rooms.map(room => ({ id: 'room-' + room.id, position: [room.center[0],(room.floorElevation||0)+0.025,room.center[2]] as Vec3 })),
          ...snapshot.findings.filter(f => f.status !== 'dismissed').map(f => ({ id: 'finding-' + f.id, position: f.anchor })),
        ];
        const update = () => {
          if (cancelled || !camera.camera || !element.clientWidth) return;
          const ctrl = controls.current, top = currentView.current === 'top';
          const target = new pc.Vec3(data.center[0]+ctrl.panX,data.center[1],data.center[2]+ctrl.panZ);
          const pitch = top ? Math.PI/2-0.001 : ctrl.pitch, radius=data.extent*2.2;
          camera.setPosition(target.x+Math.sin(ctrl.yaw)*Math.cos(pitch)*radius,target.y+Math.sin(pitch)*radius,target.z+Math.cos(ctrl.yaw)*Math.cos(pitch)*radius);
          camera.lookAt(target);
          camera.camera.orthoHeight = Math.max(data.extent*0.56,data.extent*0.65/(element.clientWidth/element.clientHeight))/ctrl.zoom;
          ownApp.renderNextFrame = true;
          const factor = ownApp.graphicsDevice.width/element.clientWidth;
          for (const marker of markers) {
            const label = labels.current.get(marker.id); if (!label) continue;
            const point = camera.camera.worldToScreen(new pc.Vec3(...marker.position));
            const x=point.x/factor,y=point.y/factor;
            label.style.transform='translate(-50%,-50%) translate('+x+'px,'+y+'px)';
            label.style.visibility = x>-30 && x<element.clientWidth+30 && y>-30 && y<element.clientHeight+30 ? 'visible' : 'hidden';
          }
        };
        const resize = () => {
          if (!element.clientWidth || !element.clientHeight) return;
          const ratio = Math.min(window.devicePixelRatio||1,1.25);
          ownApp.setCanvasResolution(pc.RESOLUTION_FIXED,Math.round(element.clientWidth*ratio),Math.round(element.clientHeight*ratio));
          canvas.style.width='100%'; canvas.style.height='100%'; update();
        };
        const reset = () => { controls.current={yaw:0.78,pitch:0.83,zoom:1,panX:0,panZ:0}; update(); };
        let pointer: { id:number; x:number; y:number; pan:boolean } | null = null;
        const down = (event: PointerEvent) => { pointer={id:event.pointerId,x:event.clientX,y:event.clientY,pan:event.shiftKey||event.button===2};canvas.setPointerCapture(event.pointerId); };
        const move = (event: PointerEvent) => {
          if(!pointer||pointer.id!==event.pointerId)return;
          const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
          if(pointer.pan){controls.current.panX-=dx*data.extent/element.clientWidth;controls.current.panZ-=dy*data.extent/element.clientHeight;}
          else{controls.current.yaw-=dx*0.008;controls.current.pitch=Math.max(0.15,Math.min(1.5,controls.current.pitch+dy*0.006));}
          pointer.x=event.clientX;pointer.y=event.clientY;update();
        };
        const up = () => { pointer=null; };
        const wheel = (event: WheelEvent) => {event.preventDefault();controls.current.zoom=Math.max(0.4,Math.min(4,controls.current.zoom*Math.exp(-event.deltaY*0.001)));update();};
        const key = (event: KeyboardEvent) => {
          if(event.target!==element)return;
          const ctrl=controls.current;
          if(event.key==='ArrowLeft')ctrl.yaw-=0.12;else if(event.key==='ArrowRight')ctrl.yaw+=0.12;else if(event.key==='ArrowUp')ctrl.pitch=Math.min(1.5,ctrl.pitch+0.08);else if(event.key==='ArrowDown')ctrl.pitch=Math.max(0.15,ctrl.pitch-0.08);else if(event.key==='+'||event.key==='=')ctrl.zoom=Math.min(4,ctrl.zoom*1.1);else if(event.key==='-')ctrl.zoom=Math.max(0.4,ctrl.zoom/1.1);else if(event.key==='0'){reset();event.preventDefault();return;}else return;
          event.preventDefault();update();
        };
        const context = (event: Event) => event.preventDefault();
        canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('contextmenu',context);element.addEventListener('keydown',key);
        const observer = new ResizeObserver(resize); observer.observe(element);
        runtime.current={app:ownApp,camera,update,reset};
        cleanup=()=>{
          runtime.current=null;observer.disconnect();
          canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('contextmenu',context);element.removeEventListener('keydown',key);
          ownApp.destroy();resources.forEach(resource=>{try{resource.destroy();}catch{/* device disposal already releases GPU allocations */}});canvas.remove();
        };
        ownApp.start(); resize(); setReady(true);
      } catch(cause) { cleanup(); if(app) {try{app.destroy();}catch{/* initialization may already have released the device */}} element.querySelector('canvas')?.remove(); if(!cancelled){setError(cause instanceof Error?cause.message:'The 3D blueprint renderer could not start.');setReady(false);} }
    })();
    return () => { cancelled=true; cleanup(); if(app && runtime.current?.app===app)runtime.current=null; };
    // The stable serialized key prevents polling from rebuilding an unchanged graphics context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey, annotationKey, hasRooms, visible]);

  if (!hasRooms) return <div className="blueprint-empty"><span>SPATIAL MODEL / AWAITING EVIDENCE</span><h3>Your space, drawn in detail.</h3><p>Auditgon creates this cutaway from the rooms, openings, and furnishings it can establish from your scan and materials.</p></div>;
  return <div className="blueprint-renderer" ref={host} tabIndex={0} role="region" aria-label="Interactive blue and white 3D cutaway blueprint. Drag to orbit, scroll to zoom, Shift-drag to pan, or use arrow keys.">
    {!ready && !error && <div className="blueprint-renderer-status"><LoaderCircle size={17} className="as-spin"/>Building the 3D blueprint…</div>}
    {error && <div className="blueprint-renderer-status" role="alert">{error}</div>}
    {ready && <div className="blueprint-labels">{snapshot.blueprint.rooms.map(room=><div key={room.id} className="blueprint-room-label" ref={node=>{if(node)labels.current.set('room-'+room.id,node);else labels.current.delete('room-'+room.id);}}>{room.name}</div>)}{showMarkers&&snapshot.findings.filter(f=>f.status!=='dismissed').map((finding,index)=><button type="button" key={finding.id} className={'blueprint-finding-pin severity-'+finding.severity+(selectedFindingId===finding.id?' selected':'')} ref={node=>{if(node)labels.current.set('finding-'+finding.id,node);else labels.current.delete('finding-'+finding.id);}} aria-label={finding.title} title={finding.title} onClick={()=>onSelectFinding(finding.id)}>{index+1}</button>)}</div>}
    <button type="button" className="blueprint-reset" aria-label="Reset 3D blueprint camera" onClick={()=>runtime.current?.reset()}><RotateCcw size={13}/></button>
  </div>;
}
