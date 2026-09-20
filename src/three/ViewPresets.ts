// 2026-09-14 新增：7 个视图预设 + 平滑过渡（lerp position/up + slerp quaternion）
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewPresetId = 'iso' | 'xp' | 'xn' | 'yp' | 'yn' | 'zp' | 'zn';

export interface ViewPreset {
  id: ViewPresetId;
  label: string;
  dir: THREE.Vector3;
  up: THREE.Vector3;
}

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export const VIEW_PRESETS: readonly ViewPreset[] = [
  { id: 'iso', label: 'ISO', dir: v(1, 1, 1).normalize(), up: v(0, 1, 0) },
  { id: 'xp', label: 'X+', dir: v(1, 0, 0), up: v(0, 1, 0) },
  { id: 'xn', label: 'X-', dir: v(-1, 0, 0), up: v(0, 1, 0) },
  // 2026-09-14 新增：Y+/Y- 的 up 改用 Z 轴，避免与 dir 平行触发万向锁
  { id: 'yp', label: 'Y+', dir: v(0, 1, 0), up: v(0, 0, -1) },
  { id: 'yn', label: 'Y-', dir: v(0, -1, 0), up: v(0, 0, 1) },
  { id: 'zp', label: 'Z+', dir: v(0, 0, 1), up: v(0, 1, 0) },
  { id: 'zn', label: 'Z-', dir: v(0, 0, -1), up: v(0, 1, 0) },
];

// 2026-09-14 新增：模块级 cancelled 标志，每次新 transition 都覆盖上一次的
let cancelRef = { cancelled: false };

function easeInOutQuad(k: number): number {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

export function applyPreset(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  preset: ViewPreset,
  modelBoundingRadius: number,
  durationMs = 400,
): Promise<void> {
  cancelRef.cancelled = true;
  const localCancel = { cancelled: false };
  cancelRef = localCancel;

  const target = controls.target.clone();
  const distance = Math.max(modelBoundingRadius * 2.6, 2);

  const toPos = target.clone().add(preset.dir.clone().multiplyScalar(distance));
  const fromPos = camera.position.clone();

  const fromUp = camera.up.clone();
  const toUp = preset.up.clone();

  // 2026-09-14 新增：用 lookAt 计算目标 quaternion，比直接 set 稳
  const m = new THREE.Matrix4().lookAt(toPos, target, toUp);
  const toQuat = new THREE.Quaternion().setFromRotationMatrix(m);
  const fromQuat = camera.quaternion.clone();

  // 2026-09-14 修复：动画期间关掉 OrbitControls，并且每帧不调 controls.update() /
  // camera.lookAt() —— update 会用 camera.position 反推 spherical 再写回 position/up
  // 把我们手算的 slerp 覆盖掉，lookAt 也会用 (0,1,0) 当 up 跟非标准 up 冲突。
  // 动画结束后把 target 同步给 controls，让下一帧 RAF 的 update() 自己重建 spherical。
  controls.enabled = false;

  return new Promise<void>((resolve) => {
    const start = performance.now();
    const tick = (): void => {
      if (localCancel.cancelled) {
        controls.enabled = true;
        resolve();
        return;
      }
      const elapsed = performance.now() - start;
      const k = Math.min(elapsed / durationMs, 1);
      const e = easeInOutQuad(k);

      camera.position.lerpVectors(fromPos, toPos, e);
      camera.up.lerpVectors(fromUp, toUp, e).normalize();
      camera.quaternion.slerpQuaternions(fromQuat, toQuat, e);

      if (k < 1) requestAnimationFrame(tick);
      else {
        // 2026-09-14 修复：动画结束把 up 与 position 强制写一次，避免浮点漂移；
        // target 同步给 controls 后由 SceneManager 的 RAF 调 controls.update() 重建 spherical。
        camera.position.copy(toPos);
        camera.up.copy(toUp).normalize();
        controls.target.copy(target);
        controls.update();
        controls.enabled = true;
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}
