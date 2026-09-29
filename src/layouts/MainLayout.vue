<template>
  <el-container class="main-layout">
    <!-- 左侧菜单栏（始终显示；可折叠到 64px） -->
    <el-aside :width="isCollapse ? '64px' : '220px'" class="sidebar">
      <div class="logo">
        <el-icon class="logo-icon"><Box /></el-icon>
        <span v-show="!isCollapse" class="logo-text">myERP</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="isCollapse"
        :collapse-transition="false"
        background-color="var(--sidebar-bg)"
        text-color="var(--sidebar-text)"
        active-text-color="var(--sidebar-text-active)"
        class="sidebar-menu"
        router
        @select="onMenuSelect"
      >
        <!-- 菜单来自后端 t_menu + t_role_menu（登录时拉回，存 localStorage）。
             菜单项定义见 MainLayout.vue 之外的 @/layouts/components/MenuTreeItem.vue
             —— 它递归渲染 <el-sub-menu> 与 <el-menu-item>。 -->
        <template v-if="menuList.length > 0">
          <MenuTreeItem v-for="m in menuList" :key="m.id" :menu="m" />
        </template>
        <div v-else class="sidebar-empty">暂无可用菜单</div>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 右侧顶部栏 -->
      <el-header class="header">
        <!-- 桌面布局：左侧 = 折叠按钮 + 面包屑；右侧 = 刷新 + 个人信息 -->
        <div class="header-left">
          <el-button link class="collapse-btn" @click="onNavToggle">
            <el-icon :size="20">
              <Fold v-if="!isCollapse" />
              <Expand v-else />
            </el-icon>
          </el-button>

          <el-breadcrumb separator="/" class="breadcrumb">
            <el-breadcrumb-item v-for="(item, idx) in breadcrumbItems" :key="idx" :to="item.to">
              {{ item.label }}
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="header-right">
          <el-tooltip content="刷新" placement="bottom">
            <el-button link @click="reload">
              <el-icon :size="18"><Refresh /></el-icon>
            </el-button>
          </el-tooltip>

          <el-dropdown trigger="click" @command="handleUserCmd">
            <div class="user-info">
              <el-avatar :size="32" class="user-avatar" />
              <span class="user-name">{{ userInfo.name }}</span>
              <el-icon><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="change-password">
                  <el-icon><Lock /></el-icon>修改密码
                </el-dropdown-item>
                <el-dropdown-item divided command="logout">
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 2026-09-28 新增：tagsView tab 栏（vue-element-admin 风格）。位于 el-header
           与 el-main 之间，36px 高，CSS-only 横向滚动；右键菜单由 TagsView.vue 内部
           维护。 -->
      <TagsView />

      <!-- 主要内容区 -->
      <el-main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <!-- 2026-09-28 新增：keep-alive 套在 router-view 上，由 tagsView 的
       cachedViewNames 控制缓存范围，切换 tab 时保留滚动位置 / 筛选 /
       未提交表单。Component 解包由 :is 自动处理；refreshSelectedView 通过
       临时摘 cachedViewNames → nextTick 重新 push 触发重挂载，比 :key 切
       换整 router-view 更轻（不破坏 transition）。 -->
            <keep-alive :include="tags.cachedViewNames">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </el-main>
    </el-container>

    <!-- 修改密码弹窗 -->
    <el-dialog
      v-model="showChangePwd"
      title="修改密码"
      :width="pwdDlg.width"
      :top="pwdDlg.top"
      @closed="resetPwdForm"
    >
      <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="90px">
        <el-form-item label="原密码" prop="oldPassword">
          <el-input
            v-model="pwdForm.oldPassword"
            type="password"
            show-password
            placeholder="请输入原密码"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="pwdForm.newPassword"
            type="password"
            show-password
            placeholder="至少 6 位"
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="pwdForm.confirmPassword"
            type="password"
            show-password
            placeholder="再次输入新密码"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showChangePwd = false">取消</el-button>
        <el-button type="primary" :loading="pwdSaving" @click="submitChangePwd">确定</el-button>
      </template>
    </el-dialog>

    <!-- 全局业务事件横幅：Teleport 到 body，右上角浮层 -->
    <NotificationBanner />
  </el-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { Box, Fold, Expand, Refresh, ArrowDown, Lock, SwitchButton } from '@element-plus/icons-vue';
// 2026-09-26：迁移到 Pinia store useAuthStore（替代原 useAuthSession 模块级单例）。
// 标量 getter 去掉括号：menus() → auth.menus；isDummyAuthActive() → auth.isDummyAuthActive。
import { useAuthStore } from '@/stores/auth';
// 2026-09-28 新增：tagsView 全局 store + 展示组件。MainLayout 把 TagsView 挂到
// el-header 与 el-main 之间，并通过 keep-alive :include 把缓存范围展开到 visitedViews。
import { useTagsViewStore, type TagView } from '@/stores/tagsView';
import { useDialogSize } from '@/composables/useDialogSize';
import { me as apiMe, changeMyPassword } from '@/api/iam';
import MenuTreeItem from '@/layouts/components/MenuTreeItem.vue';
import TagsView from '@/layouts/components/TagsView.vue';
import type { CurrentUser } from '@/types/user';

type UserCmd = 'change-password' | 'logout';

const route = useRoute();
const router = useRouter();

const isCollapse = ref(false);
const currentUser = ref<CurrentUser | null>(null);
const auth = useAuthStore();
// 2026-09-28 新增：tagsView store 单一实例（消费侧不解构，沿 auth store 不变量）。
const tags = useTagsViewStore();

const menuList = computed(() => auth.menus);

/** route → TagView 私有 mapper（与 TagsView.vue 内 mapper 等价；reload 复用）。 */
function routeToView(): TagView {
  const nameRaw = route.name as string | symbol | null | undefined;
  const name = typeof nameRaw === 'string' ? nameRaw : '';
  return {
    path: route.path,
    fullPath: route.fullPath,
    name,
    title: (route.meta?.title as string | undefined) ?? '',
    icon: route.meta?.icon as string | undefined,
    affix: route.meta?.affix === true,
  };
}

const userInfo = computed(() => ({
  name: currentUser.value?.full_name || currentUser.value?.username || '未登录',
}));

const activeMenu = computed<string>(() => route.path);

const breadcrumbItems = computed<{ label: string; to?: string }[]>(() => {
  const raw = route.meta?.breadcrumb ?? [];
  const list = raw.length > 0 ? raw : [{ label: route.meta?.title || '首页' }];
  return list.map((it, idx, arr) => ({
    label: it.label,
    to: idx === arr.length - 1 || !it.path ? undefined : it.path,
  }));
});

// 顶栏折叠按钮：切换侧栏宽度
const onNavToggle = (): void => {
  isCollapse.value = !isCollapse.value;
};

// 侧栏菜单项选中：路由跳转（<el-menu router> 已自动路由，这里冗余兜底，确保 router 实例可用）
function onMenuSelect(index: string): void {
  router.push(index);
}

// 修改密码弹窗尺寸
const pwdDlg = useDialogSize({ desktopWidth: 420 });

const reload = (): void => {
  // 2026-09-28 改造：原 router.go(0) 硬刷新整个 app → 改为 tagsView 软刷新
  // （临时从 cachedViewNames 移除当前 name → nextTick 重新 push → keep-alive 重挂
  // 载）。比硬刷新更轻（不丢失其它 tab 的滚动位置 / 状态），且与右键菜单「刷新」
  // 复用同一路径。
  //
  // 2026-09-28 修复：移除 `route.meta?.noTagsView === true` 分支——noTagsView 路由
  // （如 /login、/404）不在 MainLayout 子树，reload 按钮根本不会被触发；保留分支
  // 是 dead code + 误导性兜底（无路由能进入这条 if）。
  ElMessage.success('刷新成功');
  void tags.refreshSelectedView(routeToView());
};

const handleUserCmd = async (cmd: string | number | object): Promise<void> => {
  const command = cmd as UserCmd;
  if (command === 'logout') {
    try {
      await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      });
      await auth.logout();
      ElMessage.success('已退出登录');
      router.replace('/login');
    } catch {
      /* cancelled */
    }
  } else if (command === 'change-password') {
    showChangePwd.value = true;
  }
};

// ---- 修改密码 ----
const showChangePwd = ref(false);
const pwdSaving = ref(false);
const pwdFormRef = ref<FormInstance>();
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });

const validateNewPwd = (_rule: unknown, value: string, callback: (err?: Error) => void): void => {
  if (!value) return callback(new Error('请输入新密码'));
  if (value.length < 6) return callback(new Error('新密码至少 6 位'));
  if (value === pwdForm.oldPassword) return callback(new Error('新密码不能与原密码相同'));
  // 新密码变化时，若确认框已填，重新触发确认框校验
  if (pwdForm.confirmPassword) pwdFormRef.value?.validateField('confirmPassword');
  callback();
};
const validateConfirmPwd = (
  _rule: unknown,
  value: string,
  callback: (err?: Error) => void,
): void => {
  if (!value) return callback(new Error('请再次输入新密码'));
  if (value !== pwdForm.newPassword) return callback(new Error('两次输入的新密码不一致'));
  callback();
};
const pwdRules: FormRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [{ validator: validateNewPwd, trigger: 'blur' }],
  confirmPassword: [{ validator: validateConfirmPwd, trigger: 'blur' }],
};

function resetPwdForm(): void {
  pwdForm.oldPassword = '';
  pwdForm.newPassword = '';
  pwdForm.confirmPassword = '';
  pwdFormRef.value?.clearValidate();
}

async function submitChangePwd(): Promise<void> {
  const valid = await pwdFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  pwdSaving.value = true;
  try {
    await changeMyPassword({
      old_password: pwdForm.oldPassword,
      new_password: pwdForm.newPassword,
    });
    showChangePwd.value = false;
    ElMessage.success('密码已修改，请重新登录');
    await auth.logout();
    router.replace('/login');
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '修改密码失败');
  } finally {
    pwdSaving.value = false;
  }
}

onMounted(async () => {
  // 2026-09-11 修复：dev:dummy 模式下跳过 apiMe()。
  // 此前无脑调 /iam/me，dummy token 'dummy-dev-token' 被后端判无效 → 401 →
  // catch 里 router.replace('/login')。表现为首次打开任意页都被踢回登录页。
  // dummy 已经注入完整 CurrentUser（含 menus / roles），无需再向 /iam/me 验证。
  // 三层 prod 保护：
  //   1) isDummyAuthRequested() 在 import.meta.env.DEV=false 时整段 dead code
  //   2) useAuthStore.isDummyAuthActive 由 initDummyAuth 注入
  //   3) 后端即便返回 401，拦截器也不会触发 auth:logout（refresh 失败分支不命中）
  if (auth.isDummyAuthActive) return;
  try {
    currentUser.value = await apiMe();
  } catch {
    router.replace('/login');
  }
});
</script>

<style lang="scss" scoped>
.main-layout {
  height: 100vh;
}

.sidebar {
  background-color: var(--sidebar-bg);
  transition: width 0.3s;
  overflow: hidden;
  box-shadow: 2px 0 6px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  font-size: 20px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background-color: #142d54;

  .logo-icon {
    font-size: 24px;
    color: #7eb0e3;
  }

  .logo-text {
    letter-spacing: 1px;
  }
}

.sidebar-menu {
  flex: 1;
  min-height: 0; /* 让 flex 项可收缩至内容尺寸以下,否则溢出时不会触发滚动 */
  overflow-y: auto; /* 菜单项超出可视高度时纵向滚动 */
  border-right: none;
  background-color: var(--sidebar-bg);
}

.sidebar-menu::-webkit-scrollbar {
  width: 6px;
}

.sidebar-menu::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.sidebar-menu::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.35);
}

.sidebar-menu::-webkit-scrollbar-track {
  background-color: transparent;
}

.sidebar-empty {
  color: var(--sidebar-text);
  opacity: 0.6;
  text-align: center;
  padding: 24px 8px;
  font-size: 13px;
}

:deep(.el-menu-item:hover),
:deep(.el-sub-menu__title:hover) {
  background-color: var(--sidebar-hover) !important;
}

:deep(.el-menu-item.is-active) {
  background-color: var(--sidebar-active-bg) !important;
  color: #fff !important;
  border-left: 3px solid var(--primary-lighter);
}

:deep(.el-sub-menu .el-menu-item) {
  background-color: #142d54 !important;
  min-width: 220px;
}

.header {
  background-color: var(--header-bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  /* 2026-09-29 修复：原 box-shadow 向下扩散 4px 覆盖标签条顶部 → 改为 border-bottom
     形成干净分隔，让 .tags-view-container 视觉上不与 header 重叠。 */
  border-bottom: 1px solid var(--border-color);
  height: 60px;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.collapse-btn {
  font-size: 20px;
  color: var(--text-regular);
  padding: 4px;

  &:hover {
    color: var(--primary-color);
  }
}

.breadcrumb {
  font-size: 14px;

  :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
    color: var(--primary-color);
    font-weight: 500;
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.2s;

  &:hover {
    background-color: var(--primary-bg);
  }

  .user-avatar {
    background-color: var(--primary-light);
  }

  .user-name {
    font-size: 14px;
    color: var(--text-primary);
  }
}

.main-content {
  background-color: var(--content-bg);
  padding: 16px;
  overflow: auto;
  /* 2026-09-29 新增：建立独立 stacking context，防止页面内 position: fixed /
     阴影元素穿透到标签条之上（标签条 z-index: 5，main z-index: 1）。 */
  position: relative;
  z-index: 1;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
