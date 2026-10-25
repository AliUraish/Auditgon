'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { SceneViewerProps, Vec3 } from '@/lib/contracts';
import { buildBlueprintGeometry } from '@/lib/blueprint-geometry';
import type { AppBase, Entity } from 'playcanvas';

type Props = SceneViewerProps & { zoom: number; rotation: number };
type Runtime = { app: AppBase; camera: Entity; update: () => void; reset: () => void };

export default function BlueprintScene({ snapshot, selectedRoomId, selectedFindingId, onSelectFinding, showMarkers = true, showPath = true, viewMode, zoom, rotation }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const labels = useRef(new Map<string, HTMLDivElement | HTMLButtonElement>());
  const controls = useRef({ yaw: rotation + 1.4, pitch: 0.83, zoom: zoom * 1.3, panX: 0, panZ: 0 });
  const currentView = useRef(viewMode);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const hasRooms = snapshot.blueprint.rooms.length > 0;
  const geometryKey = JSON.stringify({ model: snapshot.blueprint, selectedRoomId, findings: snapshot.findings.map(f => [f.id,f.status,f.roomId]) });
  const scanFrame = snapshot.blueprint.coordinateFrame === 'scan';
  const annotationKey = JSON.stringify({ findings: snapshot.findings.map(f => [f.id,f.anchor,f.status,f.endAnchor,f.region]), path: showPath ? snapshot.path : [], trail: showPath && scanFrame ? snapshot.trail : [], showMarkers });

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    controls.current.zoom = zoom * 1.3; controls.current.yaw = rotation + 1.4;
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
        const { AppBase, AppOptions, CameraComponentSystem, RenderComponentSystem, LightComponentSystem, createGraphicsDevice, DEVICETYPE_WEBGL2, Entity, Color, PROJECTION_ORTHOGRAPHIC, StandardMaterial, CULLFACE_NONE, BLEND_NORMAL, Mesh, MeshInstance, PRIMITIVE_TRIANGLES, PRIMITIVE_LINES, Vec3, RESOLUTION_FIXED, Texture, ADDRESS_REPEAT, FILTER_LINEAR_MIPMAP_LINEAR, FILTER_LINEAR, PIXELFORMAT_RGBA8 } = await import('playcanvas');
        const pc = { AppBase, AppOptions, CameraComponentSystem, RenderComponentSystem, LightComponentSystem, createGraphicsDevice, DEVICETYPE_WEBGL2, Entity, Color, PROJECTION_ORTHOGRAPHIC, StandardMaterial, CULLFACE_NONE, BLEND_NORMAL, Mesh, MeshInstance, PRIMITIVE_TRIANGLES, PRIMITIVE_LINES, Vec3, RESOLUTION_FIXED, Texture, ADDRESS_REPEAT, FILTER_LINEAR_MIPMAP_LINEAR, FILTER_LINEAR, PIXELFORMAT_RGBA8 };
        if (cancelled) return;
        const data = buildBlueprintGeometry(snapshot, selectedRoomId);
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
        // Procedural finish textures, drawn once per finish and tint from what Argon observed; never photographic.
        const finishTexture = (finish: string, tint?: string) => {
          const size = 256, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
          const g = canvas.getContext('2d')!;
          const base = tint || ({ wood: '#9a6b42', tile: '#c9c2b4', carpet: '#7d7466', concrete: '#8c8f90', stone: '#8d857a', paint: '#d9d6cf', plaster: '#d3cec2', brick: '#9a4e3a', glass: '#9ec7dc', other: '#8a8f94' } as Record<string, string>)[finish] || '#8a8f94';
          g.fillStyle = base; g.fillRect(0, 0, size, size);
          const shade = (alpha: number, dark = true) => `rgba(${dark ? '0,0,0' : '255,255,255'},${alpha})`;
          const rand = (seed: number) => { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; };
          const r = rand(7);
          if (finish === 'wood') { for (let y = 0; y < size; y += 32) { g.fillStyle = shade(0.18 + r() * 0.1); g.fillRect(0, y, size, 2); const offset = (y / 32) % 2 ? 90 : 0; g.fillRect((offset + 120) % size, y, 2, 32); for (let k = 0; k < 6; k++) { g.fillStyle = shade(0.05 + r() * 0.07); g.fillRect(0, y + 4 + k * 4.5, size, 1); } } }
          else if (finish === 'tile') { for (let y = 0; y <= size; y += 64) { g.fillStyle = shade(0.35); g.fillRect(0, y - 1, size, 3); g.fillRect(y - 1, 0, 3, size); } for (let i = 0; i < 300; i++) { g.fillStyle = shade(0.04, r() > 0.5); g.fillRect(r() * size, r() * size, 3, 3); } }
          else if (finish === 'brick') { for (let y = 0; y < size; y += 32) { g.fillStyle = shade(0.35); g.fillRect(0, y, size, 3); const offset = (y / 32) % 2 ? 48 : 0; for (let x = offset; x < size + 96; x += 96) g.fillRect(x - 2, y, 4, 32); } }
          else if (finish === 'stone') { for (let i = 0; i < 40; i++) { const w = 40 + r() * 60, h = 30 + r() * 40, x = r() * size, y = r() * size; g.fillStyle = shade(0.08 + r() * 0.12, r() > 0.6); g.fillRect(x, y, w, h); g.strokeStyle = shade(0.3); g.lineWidth = 2; g.strokeRect(x, y, w, h); } }
          else if (finish === 'glass') { for (let y = 0; y <= size; y += 128) { g.fillStyle = shade(0.4, true); g.fillRect(0, y - 2, size, 4); g.fillRect(y - 2, 0, 4, size); } for (let i = 0; i < 8; i++) { g.fillStyle = shade(0.12, false); g.fillRect(i * 32, 0, 6, size); } }
          else { for (let i = 0; i < 2600; i++) { g.fillStyle = shade(finish === 'carpet' ? 0.12 : 0.06, r() > 0.5); g.fillRect(r() * size, r() * size, finish === 'carpet' ? 2 : 1.5, finish === 'carpet' ? 2 : 1.5); } }
          const texture = new pc.Texture(ownApp.graphicsDevice, { width: size, height: size, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR });
          texture.setSource(canvas); resources.push(texture); return texture;
        };
        const addMesh = (positions: number[], indices: number[] | null, normals: number[] | null, mat: ReturnType<typeof material>, primitive: number = pc.PRIMITIVE_TRIANGLES, uvs?: number[]) => {
          if (!positions.length) return;
          const mesh = new pc.Mesh(ownApp.graphicsDevice);
          mesh.setPositions(positions);
          if (indices) mesh.setIndices(indices);
          if (normals) mesh.setNormals(normals);
          if (uvs && uvs.length) mesh.setUvs(0, uvs);
          mesh.update(primitive);
          const node = new pc.Entity('Blueprint geometry');
          node.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh,mat,node)] });
          ownApp.root.addChild(node); resources.push(mesh);
        };
        for (const [key,batch] of data.batches) {
          if (batch.finish) {
            const mat = material('#d8dde3'); mat.diffuseMap = finishTexture(batch.finish, batch.tint); mat.update();
            addMesh(batch.positions,batch.indices,batch.normals,mat,pc.PRIMITIVE_TRIANGLES,batch.uvs);
          } else addMesh(batch.positions,batch.indices,batch.normals,material(key));
        }
        addMesh(data.grid,null,null,material('#3c719f',true,0.34),pc.PRIMITIVE_LINES);
        addMesh(data.edges,null,null,material('#f0f8ff',true),pc.PRIMITIVE_LINES);
        if (showPath && snapshot.path.length > 1) {
          const path:number[]=[];
          snapshot.path.slice(-400).forEach((p,i,all)=>{if(i)path.push(...all[i-1],...p);});
          addMesh(path,null,null,material('#d0e99a',true),pc.PRIMITIVE_LINES);
        }
        // Argon's drawn findings: dimension lines and surface outlines, only in a matching coordinate frame.
        const drawn = showMarkers ? snapshot.findings.filter(f => f.status !== 'dismissed' && (f.endAnchor || f.region) && (f.annotationSource !== 'scan' || scanFrame)) : [];
        const outline:number[]=[], fillPositions:number[]=[], fillNormals:number[]=[], fillIndices:number[]=[];
        for (const f of drawn) {
          if (f.endAnchor) outline.push(...f.anchor, ...f.endAnchor);
          if (f.region) {
            f.region.forEach((p,i)=>outline.push(...p, ...f.region![(i+1)%f.region!.length]));
            const base = fillPositions.length/3;
            f.region.forEach(p=>{fillPositions.push(...p);fillNormals.push(0,1,0);});
            for (let i=1;i+1<f.region.length;i++) fillIndices.push(base,base+i,base+i+1);
          }
        }
        addMesh(outline,null,null,material('#f0c27a',true),pc.PRIMITIVE_LINES);
        addMesh(fillPositions,fillIndices,fillNormals,material('#f0c27a',true,0.28));
        const trail = showPath && scanFrame ? (snapshot.trail || []).slice(-200) : [];
        if (trail.length > 1) {
          const walk:number[]=[];
          trail.forEach((p,i,all)=>{if(i)walk.push(...all[i-1],...p);});
          addMesh(walk,null,null,material('#9ad0ff',true),pc.PRIMITIVE_LINES);
        }
        const markers = [
          ...snapshot.blueprint.rooms.map(room => ({ id: 'room-' + room.id, position: [room.center[0],(room.floorElevation||0)+0.025,room.center[2]] as Vec3 })),
          ...snapshot.findings.filter(f => f.status !== 'dismissed').map(f => ({ id: 'finding-' + f.id, position: f.anchor })),
          ...snapshot.findings.filter(f => f.status !== 'dismissed' && f.endAnchor && f.measurement && (f.annotationSource !== 'scan' || scanFrame)).map(f => ({ id: 'measure-' + f.id, position: [(f.anchor[0]+f.endAnchor![0])/2,(f.anchor[1]+f.endAnchor![1])/2,(f.anchor[2]+f.endAnchor![2])/2] as Vec3 })),
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
          // Layout pass: project every label, then resolve overlaps (pins first, then measurements, then room names).
          type Placed = { id: string; el: HTMLElement; x: number; y: number; w: number; h: number; kind: 'pin' | 'measure' | 'room' };
          const projected: Placed[] = [];
          for (const marker of markers) {
            const label = labels.current.get(marker.id); if (!label) continue;
            const point = camera.camera.worldToScreen(new pc.Vec3(...marker.position));
            const x=point.x/factor,y=point.y/factor;
            const visible = x>-30 && x<element.clientWidth+30 && y>-30 && y<element.clientHeight+30;
            label.style.visibility = visible ? 'visible' : 'hidden';
            if (!visible) continue;
            projected.push({ id: marker.id, el: label, x, y, w: label.offsetWidth || 24, h: label.offsetHeight || 24, kind: marker.id.startsWith('finding-') ? 'pin' : marker.id.startsWith('measure-') ? 'measure' : 'room' });
          }
          const order = { pin: 0, measure: 1, room: 2 } as const;
          projected.sort((a, b) => order[a.kind] - order[b.kind] || a.y - b.y || a.x - b.x);
          const placed: Placed[] = [];
          const overlaps = (a: Placed, b: Placed) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 4 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 3;
          for (const item of projected) {
            // Small nudges only, so every label stays next to what it marks.
            const blockers = item.kind === 'room' ? placed.filter(other => other.kind === 'pin') : placed.filter(other => other.kind !== 'room');
            let tries = 0;
            if (item.kind === 'pin') { const ox = item.x; while (blockers.some(other => overlaps(item, other)) && tries < 4) { tries++; item.x = ox + (tries % 2 ? 1 : -1) * (item.w + 3) * Math.ceil(tries / 2); } }
            else if (item.kind === 'measure') { const oy = item.y; if (blockers.some(other => overlaps(item, other))) item.y = oy + item.h + 6; if (blockers.some(other => overlaps(item, other))) item.y = oy - item.h - 6; }
            else { const oy = item.y; if (blockers.some(other => overlaps(item, other))) item.y = oy + item.h + 8; }
            placed.push(item);
            item.el.style.transform='translate(-50%,-50%) translate('+item.x+'px,'+item.y+'px)';
          }
        };
        const resize = () => {
          if (!element.clientWidth || !element.clientHeight) return;
          const ratio = Math.min(window.devicePixelRatio||1,1.25);
          ownApp.setCanvasResolution(pc.RESOLUTION_FIXED,Math.round(element.clientWidth*ratio),Math.round(element.clientHeight*ratio));
          canvas.style.width='100%'; canvas.style.height='100%'; update();
        };
        const reset = () => { controls.current={yaw:0.78,pitch:0.83,zoom:1.3,panX:0,panZ:0}; update(); };
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
    {ready && <div className="blueprint-labels">{snapshot.blueprint.rooms.map(room=><div key={room.id} className="blueprint-room-label" ref={node=>{if(node)labels.current.set('room-'+room.id,node);else labels.current.delete('room-'+room.id);}}>{room.name}</div>)}{showMarkers&&snapshot.findings.filter(f=>f.status!=='dismissed'&&f.endAnchor&&f.measurement&&(selectedFindingId===f.id||snapshot.findings.filter(g=>g.endAnchor&&g.measurement).length<=3)).map(finding=><div key={'measure-'+finding.id} className="blueprint-measure-label" ref={node=>{if(node)labels.current.set('measure-'+finding.id,node);else labels.current.delete('measure-'+finding.id);}}>≈ {finding.measurement!.value} {finding.measurement!.units === 'm' ? 'm' : 'su'}</div>)}{showMarkers&&snapshot.findings.filter(f=>f.status!=='dismissed').map((finding,index)=><button type="button" key={finding.id} className={'blueprint-finding-pin severity-'+finding.severity+(selectedFindingId===finding.id?' selected':'')} ref={node=>{if(node)labels.current.set('finding-'+finding.id,node);else labels.current.delete('finding-'+finding.id);}} aria-label={finding.title} title={finding.title} onClick={()=>onSelectFinding(finding.id)}>{index+1}</button>)}</div>}
    <button type="button" className="blueprint-reset" aria-label="Reset 3D blueprint camera" onClick={()=>runtime.current?.reset()}><RotateCcw size={13}/></button>
  </div>;
}
