// GLSL for the plasma orb at the center of the core.

// 3D simplex noise — Ashima Arts / Stefan Gustavson (MIT).
const noise = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

export const orbVertex = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uLow;
uniform float uHigh;
uniform float uEnergy;
varying vec3 vNormal;
varying vec3 vView;
varying float vDisp;
${noise}
void main() {
  float slow = snoise(normal * 1.4 + vec3(uTime * 0.25));
  float fast = snoise(normal * 4.2 - vec3(uTime * 0.9));
  // Fine ripples for consonants ("s", "t"): high frequencies.
  float fizz = snoise(normal * 9.0 + vec3(uTime * 2.6));
  // The voice's body (low band) swells the whole orb; loudness deforms it;
  // sibilance adds fine ripples.
  float disp = slow * (0.06 + uEnergy * 0.12 + uLevel * 0.2 + uLow * 0.12)
             + fast * (0.015 + uLevel * 0.08 + uEnergy * 0.03)
             + fizz * uHigh * 0.06
             + uLow * 0.035;
  vDisp = disp;
  vec3 pos = position + normal * disp;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

export const orbFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uDeep;
uniform float uLevel;
uniform float uHigh;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vView;
varying float vDisp;
void main() {
  float facing = max(dot(vNormal, vView), 0.0);
  float rim = pow(1.0 - facing, 2.2);
  // Horizontal scan bands drifting across the surface.
  float bands = smoothstep(0.92, 1.0, sin(vNormal.y * 38.0 + uTime * 2.0)) * 0.25;
  vec3 col = mix(uDeep * 0.6, uColor, rim);
  col += uColor * (max(vDisp, 0.0) * 1.6 + uLevel * 0.35 + bands);
  col += vec3(1.0) * uHigh * rim * 0.25; // consonants flash the rim white
  col += vec3(1.0) * pow(facing, 12.0) * 0.25;
  float alpha = clamp(0.25 + rim * 0.9 + bands, 0.0, 1.0);
  gl_FragColor = vec4(col * 1.5, alpha);
}`;
