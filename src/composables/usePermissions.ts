// composables/usePermissions.ts
//
// 统一当前账号的角色 computed（PR-I 2026-07-20）。
// 用 `useAuthStore().hasRole()` 包一层，避免每个组件都重复 `hasRole('X')` 的样板。
// 2026-09-26：迁移到 Pinia store。函数式 getter 保留调用形态（auth.hasRole('X')）。
//
// 用法：
//   const { isInspector, isClerk, isManager } = usePermissions()
//   <el-button v-if="!isInspector" ...>...</el-button>
//
// 注意：
// - 这里返回的是 `ComputedRef<boolean>`，不是 boolean；模板里直接用即可。
// - 不要在 service 层或 composable 内部「读一次 hasRole 当常量」——角色可能在登录后变更。

import { computed, type ComputedRef } from 'vue';
import { useAuthStore } from '@/stores/auth';

export interface PermissionsApi {
  isManager: ComputedRef<boolean>;
  isClerk: ComputedRef<boolean>;
  isInspector: ComputedRef<boolean>;
  isCncProgrammer: ComputedRef<boolean>;
  isShelfAccount: ComputedRef<boolean>;
}

export function usePermissions(): PermissionsApi {
  // 2026-09-26：消费侧禁止解构 store（沿用 usePartsListStore 不变量 #3），统一
  // auth.xxx 访问。store.proxy 自动解包嵌套 ref，所以这里 auth.hasRole 是函数。
  const auth = useAuthStore();
  return {
    isManager: computed(() => auth.hasRole('MANAGER')),
    isClerk: computed(() => auth.hasRole('CLERK')),
    isInspector: computed(() => auth.hasRole('INSPECTOR')),
    isCncProgrammer: computed(() => auth.hasRole('CNC_PROGRAMMER')),
    isShelfAccount: computed(() => auth.hasRole('SHELF_ACCOUNT')),
  };
}
