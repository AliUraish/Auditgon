import type { BlueprintFeature, InspectionSnapshot, Vec3 } from './contracts';

type Batch = { positions: number[]; normals: number[]; indices: number[] };
export interface BlueprintGeometry {
  batches: Map<string, Batch>; edges: number[]; grid: number[];
  center: Vec3; extent: number; height: number;
}
const colors = { floor: '#0b3053', wall: '#284f76', furniture: '#1b466b', fabric: '#4e7da3', top: '#35688f', trim: '#86b0d1' };

/** Ear clipping preserves concave room boundaries instead of filling their missing corners. */
export function triangulate(polygon: [number, number][]): number[] {
  const n = polygon.length;
  if (n < 3) return [];
  const area = polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % n]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  const remaining = Array.from({ length: n }, (_, i) => area > 0 ? i : n - i - 1);
  const result: number[] = [];
  const cross = (a: number, b: number, c: number) => (polygon[b][0] - polygon[a][0]) * (polygon[c][1] - polygon[a][1]) - (polygon[b][1] - polygon[a][1]) * (polygon[c][0] - polygon[a][0]);
  let attempts = n * n;
  while (remaining.length > 3 && attempts-- > 0) {
    let found = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length], b = remaining[i], c = remaining[(i + 1) % remaining.length];
      if (cross(a, b, c) <= 1e-8) continue;
      const occupied = remaining.some(p => p !== a && p !== b && p !== c && cross(a, b, p) >= -1e-8 && cross(b, c, p) >= -1e-8 && cross(c, a, p) >= -1e-8);
      if (occupied) continue;
      result.push(a, c, b); remaining.splice(i, 1); found = true; break;
    }
    if (!found) return [];
  }
  if (remaining.length === 3) result.push(remaining[0], remaining[2], remaining[1]);
  return result;
}

export function buildBlueprintGeometry(snapshot: InspectionSnapshot, heatmap: boolean, selectedRoomId?: string | null): BlueprintGeometry {
  const rooms = snapshot.blueprint.rooms;
  const all = rooms.flatMap(room => room.polygon);
  const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
  const minZ = Math.min(...all.map(p => p[1])), maxZ = Math.max(...all.map(p => p[1]));
  const extent = Math.max(maxX - minX, maxZ - minZ, 1);
  const floor = Math.min(...rooms.map(room => room.floorElevation || 0));
  const height = Math.max(...rooms.map(room => (room.floorElevation || 0) - floor + (room.height || extent * 0.14)));
  const center: Vec3 = [(minX + maxX) / 2, floor + height * 0.25, (minZ + maxZ) / 2];
  const batches = new Map<string, Batch>(), edges: number[] = [], grid: number[] = [];
  const batch = (color: string) => { if (!batches.has(color)) batches.set(color, { positions: [], normals: [], indices: [] }); return batches.get(color)!; };
  const line = (a: Vec3, b: Vec3, into = edges) => into.push(...a, ...b);
  const box = (position: Vec3, dimensions: Vec3, color: string, yaw = 0, outline = true) => {
    if (dimensions.some(d => !Number.isFinite(d) || d <= 0)) return;
    const out = batch(color), base = out.positions.length / 3;
    const c = Math.cos(yaw), s = Math.sin(yaw), [w,h,d] = dimensions.map(v => v / 2);
    const verts: Vec3[] = [[-w,-h,-d],[w,-h,-d],[w,h,-d],[-w,h,-d],[-w,-h,d],[w,-h,d],[w,h,d],[-w,h,d]];
    const transform = ([x,y,z]: Vec3): Vec3 => [position[0] + x*c + z*s, position[1]+y, position[2]-x*s+z*c];
    const v = verts.map(transform);
    const faces = [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]];
    const normals: Vec3[] = [[0,0,-1],[0,0,1],[-1,0,0],[1,0,0],[0,1,0],[0,-1,0]];
    faces.forEach((face, i) => {
      const index = base + i * 4, [nx,ny,nz] = normals[i];
      face.forEach(j => { out.positions.push(...v[j]); out.normals.push(nx*c+nz*s, ny, -nx*s+nz*c); });
      out.indices.push(index,index+1,index+2,index,index+2,index+3);
    });
    if (outline) [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]].forEach(([a,b]) => line(v[a],v[b]));
  };
  const wallEdges = new Map<string, { a: [number,number]; b: [number,number]; floor: number; height: number; count: number }>();
  for (const room of rooms) {
    const f = room.floorElevation || 0;
    const active = snapshot.findings.filter(item => item.roomId === room.id && ['open','review'].includes(item.status));
    const roomChecks = snapshot.checklist.filter(item => item.roomId === room.id);
    const color = heatmap ? active.length ? '#805848' : roomChecks.some(item => item.status === 'blocked') ? '#746244' : roomChecks.length && roomChecks.every(item => item.status === 'pass') ? '#366d72' : '#18466f' : selectedRoomId === room.id ? '#20578a' : colors.floor;
    const out = batch(color), base = out.positions.length / 3;
    room.polygon.forEach(([x,z]) => { out.positions.push(x,f,z); out.normals.push(0,1,0); });
    out.indices.push(...triangulate(room.polygon).map(i => i+base));
    room.polygon.forEach((a,i) => {
      const b = room.polygon[(i+1)%room.polygon.length];
      line([a[0],f+0.002,a[1]],[b[0],f+0.002,b[1]]);
      const key = [a.map(v=>v.toFixed(3)).join(','),b.map(v=>v.toFixed(3)).join(',')].sort().join(':') + ':' + f.toFixed(3);
      const existing = wallEdges.get(key);
      if (existing) existing.count++;
      else wallEdges.set(key,{a,b,floor:f,height:room.height || extent * 0.14,count:1});
    });
    // Architectural floor hatching is a rendering treatment, not inferred floor construction.
    const roomMinX = Math.min(...room.polygon.map(p=>p[0])), roomMaxX = Math.max(...room.polygon.map(p=>p[0]));
    const roomMinZ = Math.min(...room.polygon.map(p=>p[1])), roomMaxZ = Math.max(...room.polygon.map(p=>p[1]));
    const step = extent/80;
    for (let z=roomMinZ+step;z<roomMaxZ;z+=step) {
      const intersections:number[]=[];
      room.polygon.forEach((p,i)=>{const q=room.polygon[(i+1)%room.polygon.length];if((p[1]<=z&&q[1]>z)||(q[1]<=z&&p[1]>z))intersections.push(p[0]+(z-p[1])*(q[0]-p[0])/(q[1]-p[1]));});
      intersections.sort((a,b)=>a-b);
      for(let i=0;i+1<intersections.length;i+=2) if(intersections[i]>=roomMinX&&intersections[i+1]<=roomMaxX)line([intersections[i],f+0.003,z],[intersections[i+1],f+0.003,z],grid);
    }
  }
  const thickness = extent * 0.006;
  const openings = snapshot.blueprint.features.filter(feature => ['door','window'].includes(feature.kind) && feature.dimensions);
  for (const edge of wallEdges.values()) {
    const dx=edge.b[0]-edge.a[0], dz=edge.b[1]-edge.a[1], length=Math.hypot(dx,dz);
    if (length < thickness) continue;
    const ux=dx/length, uz=dz/length, yaw=-Math.atan2(dz,dx);
    const outerFront=edge.count===1 && ((edge.a[0]+edge.b[0])/2-center[0] + (edge.a[1]+edge.b[1])/2-center[2])>extent*0.08;
    const wallHeight = outerFront ? edge.height * 0.38 : edge.height;
    const segments = openings.map(feature => {
      const px=feature.position[0]-edge.a[0], pz=feature.position[2]-edge.a[1], t=px*ux+pz*uz;
      const distance=Math.abs(px*uz-pz*ux), dims=feature.dimensions!;
      return {feature,t,width:Math.min(dims[0],length), bottom:Math.max(0,feature.position[1]-dims[1]/2-edge.floor),top:Math.min(wallHeight,feature.position[1]+dims[1]/2-edge.floor),distance};
    }).filter(item=>item.distance<thickness*5 && item.t>0 && item.t<length && item.top>item.bottom).sort((a,b)=>a.t-b.t);
    const piece = (a:number,b:number,bottom=0,top=wallHeight) => {if(b-a>thickness/4 && top-bottom>thickness/4)box([edge.a[0]+ux*(a+b)/2,edge.floor+(top+bottom)/2,edge.a[1]+uz*(a+b)/2],[b-a,top-bottom,thickness],colors.wall,yaw);};
    let cursor=0;
    for(const opening of segments){
      const left=Math.max(cursor,opening.t-opening.width/2),right=Math.min(length,opening.t+opening.width/2);
      if(right<=left)continue;
      piece(cursor,left); piece(left,right,0,opening.bottom);piece(left,right,opening.top,wallHeight);
      // The frame outlines the observed opening without inventing door operation.
      const a:Vec3=[edge.a[0]+ux*left,edge.floor+opening.bottom,edge.a[1]+uz*left],b:Vec3=[edge.a[0]+ux*right,edge.floor+opening.top,edge.a[1]+uz*right];
      line(a,[a[0],b[1],a[2]]);line([a[0],b[1],a[2]],b);line(b,[b[0],a[1],b[2]]);
      if(opening.feature.kind==='window'){line(a,[b[0],a[1],b[2]]);const mid:Vec3=[(a[0]+b[0])/2,a[1],(a[2]+b[2])/2];line(mid,[mid[0],b[1],mid[2]]);}
      cursor=right;
    }
    piece(cursor,length);
  }
  const furniture = (feature: BlueprintFeature) => {
    if(!feature.dimensions)return;
    const [w,h,d]=feature.dimensions, origin=feature.position, yaw=(feature.rotation||0)*Math.PI/180;
    const c=Math.cos(yaw),s=Math.sin(yaw);
    const part=(x:number,y:number,z:number,pw:number,ph:number,pd:number,color=colors.furniture)=>box([origin[0]+x*c+z*s,origin[1]+y,origin[2]-x*s+z*c],[pw,ph,pd],color,yaw);
    const floor=-h/2;
    if(feature.kind==='stair'){
      const count=8;for(let i=0;i<count;i++)part(0,floor+h*(i+1)/(2*count),-d/2+d*(i+0.5)/count,w,h*(i+1)/count,d/count,colors.top);return;
    }
    const type=feature.kind==='island'?'cabinet':feature.objectType||'other';
    if(type==='bed'){
      part(0,floor+h*.22,0,w,h*.22,d);part(0,floor+h*.47,0,w*.96,h*.22,d*.98,colors.fabric);part(0,floor+h*.78,-d*.46,w,h*.44,d*.08,colors.top);
      part(-w*.24,floor+h*.64,-d*.27,w*.38,h*.14,d*.22,colors.trim);part(w*.24,floor+h*.64,-d*.27,w*.38,h*.14,d*.22,colors.trim);
      part(0,floor+h*.61,d*.18,w*.97,h*.04,d*.55,colors.top);
    }else if(type==='sofa'){
      part(0,floor+h*.27,0,w,h*.3,d);part(0,floor+h*.72,-d*.38,w,h*.56,d*.22,colors.fabric);
      part(-w*.45,floor+h*.5,0,w*.1,h*.55,d,colors.top);part(w*.45,floor+h*.5,0,w*.1,h*.55,d,colors.top);
      for(let i=0;i<3;i++)part(-w*.28+i*w*.28,floor+h*.49,d*.06,w*.27,h*.15,d*.63,colors.fabric);
    }else if(type==='table'||type==='chair'){
      const top=type==='chair'?h*.43:h*.89;part(0,floor+top,0,w,h*.09,d,colors.top);
      for(const x of [-1,1])for(const z of [-1,1])part(x*w*.39,floor+top*.5,z*d*.39,w*.055,top,d*.055);
      if(type==='chair')part(0,floor+h*.76,-d*.43,w*.95,h*.49,d*.09,colors.fabric);
    }else if(type==='cabinet'||type==='wardrobe'){
      part(0,0,0,w,h,d);part(0,h*.47,0,w*1.03,h*.06,d*1.03,colors.top);
      for(let i=0;i<Math.min(5,Math.max(2,Math.round(w/Math.max(h*.7,.01))));i++){const count=Math.min(5,Math.max(2,Math.round(w/Math.max(h*.7,.01))));part(-w/2+w*(i+.5)/count,0,d*.505,w/count*.93,h*.86,d*.012,colors.top);}
    }else if(type==='sink'||type==='tub'){
      part(0,-h*.12,0,w,h*.75,d);part(-w*.46,h*.39,0,w*.08,h*.2,d,colors.trim);part(w*.46,h*.39,0,w*.08,h*.2,d,colors.trim);part(0,h*.39,-d*.46,w,h*.2,d*.08,colors.trim);part(0,h*.39,d*.46,w,h*.2,d*.08,colors.trim);
    }else if(type==='toilet'){
      part(0,-h*.14,d*.12,w*.8,h*.65,d*.72,colors.fabric);part(0,h*.11,-d*.32,w,h*.76,d*.25,colors.trim);
    }else if(type==='lamp'){
      part(0,floor+h*.04,0,w*.6,h*.08,d*.6,colors.top);part(0,0,0,w*.06,h*.95,d*.06,colors.trim);part(0,h*.32,0,w,h*.3,d,colors.fabric);
    }else if(type==='plant'){
      part(0,floor+h*.18,0,w*.6,h*.36,d*.6);part(0,h*.14,0,w*.78,h*.65,d*.78,colors.top);
    }else box(origin,[w,h,d],colors.furniture,yaw);
  };
  snapshot.blueprint.features.filter(feature=>['furniture','island','stair'].includes(feature.kind)).slice(0,200).forEach(furniture);
  const gridExtent=extent*.9, step=extent/32;
  for(let i=-32;i<=32;i++){const a=i*step;line([center[0]+a,floor-.02,center[2]-gridExtent],[center[0]+a,floor-.02,center[2]+gridExtent],grid);line([center[0]-gridExtent,floor-.02,center[2]+a],[center[0]+gridExtent,floor-.02,center[2]+a],grid);}
  return {batches,edges,grid,center,extent,height};
}
