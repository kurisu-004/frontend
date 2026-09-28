// src/components/cosUploaderPickPlan.ts
//
// 2026-09-28 新增：把 CosUploader 组件内 onPick 合批 / 校验逻辑抽成纯函数，
// 便于在 node 环境独立测试（项目无 happy-dom / @vue/test-utils 依赖）。
//
// 2026-09-28 调整：按 composable 归属判别（跨域共享约束）下沉到 components/，
// 与 CosUploader.vue 同目录；仓内仅 CosUploader.vue 单点消费，不进 composables/。
//
// 导出函数：
// - matchesAccept(file, accept)：解析 ".pdf" / "image/*" / "image/jpeg" / "jpeg" 四种 token 形态
// - planPick(buffer, opts, currentCount)：返回四类拒绝列表 + 通过列表，组件 flushPickBuffer 直接消费。

export interface PickPlanLimits {
  maxSizeMB?: number;
  accept?: string;
  limit?: number;
  multiple?: boolean;
}

export interface PickPlanRejection {
  file: File;
  reason: string;
}

export interface PickPlanResult {
  accepted: File[];
  rejectedByLimit: File[];
  rejectedBySize: PickPlanRejection[];
  rejectedByAccept: PickPlanRejection[];
  rejectedByMultiple: PickPlanRejection[];
}

export function matchesAccept(file: File, accept: string): boolean {
  const tokens = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (name.endsWith(token)) return true;
    } else if (token.endsWith('/*')) {
      const prefix = token.slice(0, -2);
      if (type.startsWith(prefix + '/')) return true;
    } else if (token.includes('/')) {
      if (type === token) return true;
    } else {
      const subtype = type.split('/')[1] ?? '';
      if (subtype === token) return true;
    }
  }
  return false;
}

export function planPick(
  buffer: File[],
  opts: PickPlanLimits,
  currentCount: number,
): PickPlanResult {
  const result: PickPlanResult = {
    accepted: [],
    rejectedByLimit: [],
    rejectedBySize: [],
    rejectedByAccept: [],
    rejectedByMultiple: [],
  };

  // limit
  let pool = buffer;
  if (opts.limit !== undefined && opts.limit > 0) {
    const remaining = Math.max(0, opts.limit - currentCount);
    if (remaining === 0) {
      result.rejectedByLimit = [...buffer];
      return result;
    }
    if (buffer.length > remaining) {
      result.rejectedByLimit = buffer.slice(remaining);
      pool = buffer.slice(0, remaining);
    }
  }

  // size / accept
  const valid: File[] = [];
  for (const f of pool) {
    if (opts.maxSizeMB !== undefined && f.size > opts.maxSizeMB * 1024 * 1024) {
      result.rejectedBySize.push({ file: f, reason: `文件「${f.name}」超过 ${opts.maxSizeMB}MB 限制` });
      continue;
    }
    if (opts.accept && !matchesAccept(f, opts.accept)) {
      result.rejectedByAccept.push({
        file: f,
        reason: `文件「${f.name}」类型不被接受（仅 ${opts.accept}）`,
      });
      continue;
    }
    valid.push(f);
  }

  // multiple
  if (opts.multiple === false && valid.length > 1) {
    for (let i = 1; i < valid.length; i += 1) {
      const f = valid[i]!;
      result.rejectedByMultiple.push({ file: f, reason: `仅支持单文件上传，「${f.name}」已忽略` });
    }
    valid.splice(1);
  }

  result.accepted = valid;
  return result;
}
