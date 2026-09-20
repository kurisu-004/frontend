// 2026-09-20 重写：Scene + Camera + Renderer + 光照 + 网格 + RAF + 资源 dispose
//
// 设计（重构后）：
//   - 只负责场景/相机/渲染的基础能力（加载模型、控制视角、渲染循环）
//   - 鼠标按钮：左键 ROTATE，中键 PAN（用户要求，2026-09-20）
//   - 移除高亮系统（measure 用，已删除）
//   - 移除 LineMaterial 注册表（loader 现在自管理 LineMaterial.resolution）
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

export class SceneManager {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly controls: OrbitControls;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private modelRoot: THREE.Object3D | null = null;
  private rafId: number | null = null;
  private resizeHandler: () => void;
  private hostEl: HTMLElement | null = null;
  private canvasSize: { w: number; h: number } = { w: 1, h: 1 };
  private lineMaterials = new Set<LineMaterial>();

  public constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    // 2026-09-20 改：背景用浅灰蓝（#eef1f5），护眼、不纯白
    this.scene.background = new THREE.Color(0xeef1f5);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.camera.position.set(3, 3, 3);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = false;
    // 2026-09-20 重构：左键旋转、中键平移（用户要求）
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: null as unknown as THREE.MOUSE,
    };
    // 滚轮缩放默认开启（不需要按住键）
    this.controls.zoomSpeed = 1.0;

    // 环境光 + 两路方向光，让标准材质有立体感
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
    keyLight.position.set(5, 10, 7);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xeef4ff, 0.4);
    fillLight.position.set(-5, -5, -5);
    this.scene.add(fillLight);

    // 地面网格 + 坐标轴（浅灰底用深色网格，避免太刺眼）
    this.grid = new THREE.GridHelper(20, 20, 0x8a929c, 0xc4cad2);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(5);
    (this.axes.material as THREE.Material).transparent = true;
    (this.axes.material as THREE.Material).opacity = 0.7;
    this.scene.add(this.axes);

    this.resizeHandler = (): void => this.onResize();
    window.addEventListener('resize', this.resizeHandler);
  }

  public mount(canvasContainer: HTMLElement): void {
    this.hostEl = canvasContainer;
    this.onResize();
    this.start();
  }

  /** 注册 LineMaterial（resolution 由 SceneManager 在 resize / mount 时统一更新） */
  public registerLineMaterial(m: LineMaterial): void {
    this.lineMaterials.add(m);
    m.resolution.set(this.canvasSize.w, this.canvasSize.h);
  }

  public unmount(): void {
    this.stop();
    window.removeEventListener('resize', this.resizeHandler);
    this.controls.dispose();
    this.renderer.dispose();
    if (this.modelRoot) {
      this.disposeModel(this.modelRoot);
      this.modelRoot = null;
    }
  }

  public setModel(group: THREE.Object3D): void {
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      this.disposeModel(this.modelRoot);
    }
    this.modelRoot = group;
    this.scene.add(group);
    // boundingSphere 写进 userData，供 ViewPresets / CubeGizmo 用
    const box = new THREE.Box3().setFromObject(group);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
      this.modelRoot.userData['boundingRadius'] = 1;
    } else {
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      this.modelRoot.userData['boundingRadius'] = sphere.radius;
    }
  }

  public getModelRoot(): THREE.Object3D | null {
    return this.modelRoot;
  }

  /** 与 setModel 等价（保留语义化命名）；调用方：App / ViewerCanvas */
  public setLoadedShape(loaded: { root: THREE.Object3D }): void {
    this.setModel(loaded.root);
  }

  public getModelBoundingRadius(): number {
    if (!this.modelRoot) return 1;
    const r = this.modelRoot.userData['boundingRadius'];
    return typeof r === 'number' && r > 0 ? r : 1;
  }

  public setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.axes.visible = v;
  }

  public isGridVisible(): boolean {
    return this.grid.visible;
  }

  /** 2026-09-20 重构：滚轮缩放当前始终开启；该函数保留为兼容 store 调用，但无效化 */
  public setCameraMode(_mode: 'rotate' | 'pan'): void {
    /* no-op：左键=ROTATE / 中键=PAN 是固定的，不再切换 */
  }

  public onResize(): void {
    if (!this.hostEl) return;
    const { clientWidth: w, clientHeight: h } = this.hostEl;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.canvasSize = { w, h };
    for (const m of this.lineMaterials) m.resolution.set(w, h);
  }

  private start(): void {
    if (this.rafId !== null) return;
    const animate = (): void => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(animate);
    };
    this.rafId = requestAnimationFrame(animate);
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private disposeModel(group: THREE.Object3D): void {
    group.traverse((obj: THREE.Object3D) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else if (mat) {
        mat.dispose();
      }
    });
  }
}

// 抑制 unused 警告（canvasSize 留作未来 LineMaterial.resolution 维护用）
void Object;
