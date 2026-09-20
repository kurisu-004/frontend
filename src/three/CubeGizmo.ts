// 2026-09-20 重构：视角导航正方体 CubeGizmo
// 保留：自管理 Scene + PerspectiveCamera + WebGLRenderer
//       主立方体 6 面 CanvasTexture 写汉字「前 / 后 / 左 / 右 / 上 / 下」
//       位置：固定右上角（offsetX=16, offsetY=16）
//       视角同步：每帧 cube.quaternion = camera.quaternion.clone().invert()
//       拖拽旋转：pointerdown 累积 delta → 绕 controls.target 旋转 camera（不改 distance）
//       点击面：raycaster 命中面 → applyPreset(camera, controls, VIEW_PRESETS[id])
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyPreset, VIEW_PRESETS } from './ViewPresets';

const CUBE_SIZE = 1;
const RENDER_PX = 128;
const FACE_LABEL_COLOR = '#ffffff';
const FACE_HIGHLIGHT_COLOR = '#ffcc00';

interface CubeFaceSpec {
  id: 'xp' | 'xn' | 'yp' | 'yn' | 'zp' | 'zn';
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
  label: string;
}

const FACE_SPECS: CubeFaceSpec[] = [
  { id: 'xp', axis: 'x', sign: 1, label: '右' },
  { id: 'xn', axis: 'x', sign: -1, label: '左' },
  { id: 'yp', axis: 'y', sign: 1, label: '上' },
  { id: 'yn', axis: 'y', sign: -1, label: '下' },
  { id: 'zp', axis: 'z', sign: 1, label: '前' },
  { id: 'zn', axis: 'z', sign: -1, label: '后' },
];

function makeFaceTexture(label: string, highlight = false): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = highlight ? FACE_HIGHLIGHT_COLOR : '#1e4d8b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = FACE_LABEL_COLOR;
  ctx.font = 'bold 72px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

interface CubeGizmoOptions {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  host: HTMLElement;
  getBoundingRadius: () => number;
  // 拖拽时主 OrbitControls 应禁用，否则会冲突
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export class CubeGizmo {
  private static readonly DRAG_THRESHOLD_PX = 5;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private cube: THREE.Mesh;
  private host: HTMLElement;
  private cameraRef: THREE.PerspectiveCamera;
  private controlsRef: OrbitControls;
  private getBoundingRadius: () => number;
  private rafId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragging = false;
  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private onDragStartCb: (() => void) | null;
  private onDragEndCb: (() => void) | null;
  private lastAppliedPresetAt = 0;
  private resizeObserver: ResizeObserver | null = null;
  private pendingFaceId: 'xp' | 'xn' | 'yp' | 'yn' | 'zp' | 'zn' | null = null;
  private dragMoved = false;

  public constructor(opts: CubeGizmoOptions) {
    this.cameraRef = opts.camera;
    this.controlsRef = opts.controls;
    this.host = opts.host;
    this.getBoundingRadius = opts.getBoundingRadius;
    this.onDragStartCb = opts.onDragStart ?? null;
    this.onDragEndCb = opts.onDragEnd ?? null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.camera.position.set(0, 0, 3);

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '16px';
    this.canvas.style.right = '16px';
    this.canvas.style.width = `${RENDER_PX}px`;
    this.canvas.style.height = `${RENDER_PX}px`;
    this.canvas.style.zIndex = '200';
    this.canvas.style.cursor = 'grab';
    this.canvas.style.background = 'rgba(245, 247, 250, 0.85)';
    this.canvas.style.borderRadius = '4px';
    this.canvas.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
    this.canvas.style.touchAction = 'none';
    this.host.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(RENDER_PX, RENDER_PX, false);

    const materials: THREE.MeshBasicMaterial[] = [];
    for (const spec of FACE_SPECS) {
      materials.push(new THREE.MeshBasicMaterial({ map: makeFaceTexture(spec.label) }));
    }
    const geom = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    this.cube = new THREE.Mesh(geom, materials);
    this.scene.add(this.cube);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => {
      /* position fixed; nothing to recompute */
    });
    this.resizeObserver.observe(this.host);

    this.start();
  }

  public setVisible(v: boolean): void {
    this.canvas.style.display = v ? 'block' : 'none';
  }

  public dispose(): void {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.renderer.dispose();
    for (const m of this.cube.material as THREE.MeshBasicMaterial[]) {
      m.map?.dispose();
      m.dispose();
    }
    this.cube.geometry.dispose();
    if (this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
  }

  private start(): void {
    if (this.rafId !== null) return;
    const tick = (): void => {
      this.cube.quaternion.copy(this.cameraRef.quaternion).invert();
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private ndcFromEvent(evt: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((evt.clientX - rect.left) / rect.width) * 2 - 1,
      -((evt.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private onPointerDown = (evt: PointerEvent): void => {
    evt.preventDefault();
    evt.stopPropagation();
    this.canvas.setPointerCapture?.(evt.pointerId);
    const ndc = this.ndcFromEvent(evt);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.cube);
    this.dragStartX = evt.clientX;
    this.dragStartY = evt.clientY;
    if (hits.length > 0) {
      const hit = hits[0];
      if (hit.face) {
        const spec = FACE_SPECS[hit.face.materialIndex];
        if (spec) {
          this.pendingFaceId = spec.id;
          this.dragMoved = false;
          return;
        }
      }
    }
    this.pendingFaceId = null;
    this.dragMoved = false;
    this.dragging = true;
    this.canvas.style.cursor = 'grabbing';
    this.onDragStartCb?.();
  };

  private onPointerMove = (evt: PointerEvent): void => {
    if (!this.dragging && !this.pendingFaceId) return;
    const dx = evt.clientX - this.dragStartX;
    const dy = evt.clientY - this.dragStartY;
    if (!this.dragMoved && Math.hypot(dx, dy) < CubeGizmo.DRAG_THRESHOLD_PX) return;
    if (!this.dragMoved) {
      this.dragMoved = true;
      if (this.pendingFaceId) this.pendingFaceId = null;
      this.dragging = true;
      this.canvas.style.cursor = 'grabbing';
      this.onDragStartCb?.();
    }
    const speed = 0.008;
    const offset = new THREE.Vector3().subVectors(this.cameraRef.position, this.controlsRef.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -dx * speed);
    const right = new THREE.Vector3().crossVectors(offset, this.cameraRef.up).normalize();
    offset.applyAxisAngle(right, dy * speed);
    this.cameraRef.position.copy(this.controlsRef.target).add(offset);
    this.cameraRef.lookAt(this.controlsRef.target);
    this.controlsRef.update();
    this.dragStartX = evt.clientX;
    this.dragStartY = evt.clientY;
  };

  private onPointerUp = (_evt: PointerEvent): void => {
    if (this.dragging) {
      this.dragging = false;
      this.canvas.style.cursor = 'grab';
      this.controlsRef.update();
      this.onDragEndCb?.();
      return;
    }
    if (this.pendingFaceId && !this.dragMoved) {
      const id = this.pendingFaceId;
      this.pendingFaceId = null;
      const preset = VIEW_PRESETS.find((p) => p.id === id);
      if (preset) {
        const now = performance.now();
        if (now - this.lastAppliedPresetAt < 50) return;
        this.lastAppliedPresetAt = now;
        void applyPreset(this.cameraRef, this.controlsRef, preset, this.getBoundingRadius(), 250);
      }
    }
  };
}
