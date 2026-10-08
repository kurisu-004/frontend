// src/api/shelves.spec.ts
//
// 2026-10-10 新增：货架管理 CRUD 端点**迁 iam 域**的 URL 契约守卫。
//
// 迁移动因（后端）：`src/modules/shelf/` 整模块搬到 `src/modules/iam/shelf/`，
// 4 条 CRUD 端点的 URL 前缀**硬切**到 `/api/v2/iam/shelves/*`，**无 alias** ——
// 旧路由已从后端删除。请求 / 响应契约逐字不变，所以本次只改 URL 字符串。
//
//   GET  /shelves                 → GET  /iam/shelves
//   POST /shelves                 → POST /iam/shelves
//   POST /shelves/{id}/update     → POST /iam/shelves/{id}/update
//   POST /shelves/{id}/deactivate → POST /iam/shelves/{id}/deactivate
//
// 守卫分两块：
//   - D1~D4：4 个函数各自逐字钉死 URL（挡住「把旧路径抄回去」与「搬域时漏改某一条」）。
//   - D5：**行为级**负向扫描 —— 逐个调用本模块全部发请求的函数，收集 mock 收到的
//     实际 URL，断言没有一条以 `/shelves` 开头。与 D1~D4 的关系：D1~D4 是逐条
//     点名，D5 是「未来新增端点忘了跟随后端搬域」时的兜底（新增函数不写断言就
//     会被 D5 的 `expect(urls).toHaveLength(n)` 顶出来）。
//   - D6：**源码级**全仓扫描 —— 行为级断言只覆盖 `@/api/shelves`，而「全仓无残留
//     旧前缀」要求连别的文件（新增的 api 函数、内联的 axios 调用）都算进去。
//     D6 剥掉注释后扫 `src/**` 的 `api.get|post|put|delete('/shelves...')` 形态，
//     剥注释是必需的：注释里写着「旧路径 `/shelves/processes` 已 404」是**正确的**
//     变更记录，不该被当成残留。静态扫描的代价是「改注释即红」，故这里刻意只在
//     「剥完注释后仍命中请求调用形态」时报错 —— 注释改动不会触发。
//
// mock 手法沿 `shelfProcesses.spec.ts` 同款：整模块桩掉 `@/api/http`（不
// importOriginal），只保留 `api.get` / `api.post` 两个可断言入口 + `cleanParams`。
// 工序映射那 3 个端点（`/prod/shelf-processes*`，属 prod 域）由
// `shelfProcesses.spec.ts` 的 C1~C5 守卫，本文件不重复覆盖，只在 D5 里一并纳入
// 「不得出现 `/shelves` 前缀」的负向扫描。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const httpGetMock = vi.fn();
const httpPostMock = vi.fn();

vi.mock('@/api/http', () => ({
  api: {
    get: (...args: unknown[]) => httpGetMock(...args),
    post: (...args: unknown[]) => httpPostMock(...args),
  },
  cleanParams: (obj?: Record<string, unknown>) => obj ?? {},
}));

import {
  createShelf,
  deactivateShelf,
  getAllShelfProcessMappings,
  getShelfProcesses,
  listShelves,
  setShelfProcesses,
  updateShelf,
} from './shelves';

beforeEach(() => {
  httpGetMock.mockReset();
  httpPostMock.mockReset();
});

describe('2026-10-10：货架管理 CRUD 端点迁 iam 域的 URL 契约（shelves.ts）', () => {
  it('D1：listShelves 打 GET /iam/shelves，且查询参数原样透传', async () => {
    httpGetMock.mockResolvedValue({ data: { items: [], total: 0 } });

    await listShelves({ zone: 'PRODUCTION', is_active: true, limit: 500 });

    expect(httpGetMock).toHaveBeenCalledTimes(1);
    expect(httpGetMock).toHaveBeenCalledWith('/iam/shelves', {
      params: { zone: 'PRODUCTION', is_active: true, limit: 500 },
    });
    // 无参调用也走同一前缀（cleanParams 兜空对象，不是省略 params 键）。
    httpGetMock.mockClear();
    await listShelves();
    expect(httpGetMock).toHaveBeenCalledWith('/iam/shelves', { params: {} });
  });

  it('D2：createShelf 打 POST /iam/shelves，body 原样透传', async () => {
    httpPostMock.mockResolvedValue({ data: { id: '8800000000009' } });

    await createShelf({
      code: 'SH-P09',
      name: '生产架 09',
      zone: 'PRODUCTION',
      display_order: 90,
      capacity: 100,
    });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock).toHaveBeenCalledWith('/iam/shelves', {
      code: 'SH-P09',
      name: '生产架 09',
      zone: 'PRODUCTION',
      display_order: 90,
      capacity: 100,
    });
  });

  it('D3：updateShelf 打 POST /iam/shelves/{id}/update（id 落在路径段里）', async () => {
    httpPostMock.mockResolvedValue({ data: { id: '8800000000001' } });

    await updateShelf('8800000000001', { name: '生产架 01 改', capacity: null });

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    expect(httpPostMock).toHaveBeenCalledWith('/iam/shelves/8800000000001/update', {
      name: '生产架 01 改',
      capacity: null,
    });
  });

  it('D4：deactivateShelf 打 POST /iam/shelves/{id}/deactivate，且不发明 body', async () => {
    httpPostMock.mockResolvedValue({ data: { id: '8800000000001' } });

    await deactivateShelf('8800000000001');

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    // 逐字二元组：后端 deactivate 是无 body 的 POST，冒出一个 `{}` 也不该算错但会
    // 让「这条请求无 body」这条事实不可读，故锁死只传 URL。
    expect(httpPostMock).toHaveBeenCalledWith('/iam/shelves/8800000000001/deactivate');
    expect(httpPostMock.mock.calls[0]).toHaveLength(1);
  });

  it('D5：全部 7 个发请求的函数，无一条 URL 以 /shelves 开头', async () => {
    // 行为级负向扫描。覆盖本模块**所有**发请求的函数（含 3 个工序映射端点），
    // 判据是「收集 mock 实际收到的 URL」而不是「读源码文本」—— 前者不绑注释。
    // `expect(urls).toHaveLength(7)` 是「将来新增端点忘了写逐字断言」的报警器：
    // 数字一变就必须回来补 D1~D4 里的某条逐字断言或明确豁免。
    httpGetMock.mockResolvedValue({ data: { items: [], total: 0 } });
    httpPostMock.mockResolvedValue({ data: null });

    await listShelves();
    await createShelf({ code: 'C', name: 'N', zone: 'PRODUCTION' });
    await updateShelf('1', { name: 'N' });
    await deactivateShelf('1');
    await getShelfProcesses('1');
    await setShelfProcesses('1', { items: [] });
    await getAllShelfProcessMappings();

    const urls = [
      ...httpGetMock.mock.calls.map((c) => c[0] as string),
      ...httpPostMock.mock.calls.map((c) => c[0] as string),
    ];
    expect(urls).toHaveLength(7);
    for (const url of urls) {
      // 旧前缀的完整形态逐字排除：全集 `/shelves` 与单架 `/shelves/{id}/update`
      // 等。`^` 锚定是关键 —— `/iam/shelves` 恒不以 `/shelves` 开头，前缀互斥。
      expect(url).not.toMatch(/^\/shelves(\/|$|\?)/);
      // 当前只有两个合法命名空间：iam（CRUD）与 prod（工序映射）。
      expect(url.startsWith('/iam/shelves') || url.startsWith('/prod/shelf-processes')).toBe(true);
    }
  });

  it('D6：全仓源码扫描 —— 没有任何一处请求打 /shelves 前缀', () => {
    // D5 的覆盖面是「@/api/shelves 导出的函数」；D6 把范围扩到 `src/**` 全部源
    // 文件，挡住「新写了别的 api 函数打旧路径」这种 D5 看不见的残留。
    //
    // 之所以需要静态扫描：后端旧路由**无 alias、已彻底删除**，残留一条
    // `/shelves` 请求的表现是运行期 404 —— 货架管理页白屏 / 账号管理的货架绑定
    // 下拉空，没有编译期信号。
    //
    // 扫描前**必须剥注释**：本仓大量注释里写着「`/shelves/processes` 已 404」这类
    // 变更记录，那是必须保留的历史，不该被判成残留（剥法见本文件末尾 stripComments）。
    //
    // 只匹配「请求调用形态」（`api.get|post|put|delete('<字面量>'`），不匹配裸字符串：
    // 否则 `src/composables/__fixtures__/adminMenus.ts` 里刻意保持的菜单
    // `path: '/shelves'`（前端路由 / 后端菜单表字段，见 CLAUDE.md「目录归位」）
    // 会被误判。
    const ROOT = fileURLToPath(new URL('../..', import.meta.url));
    const SRC = join(ROOT, 'src');
    // 扫 src 下全部 .ts / .vue，**只跳过 __tests__ 目录**（断言里必然出现旧字面量）。
    //
    // ⚠️ **本文件也在扫描范围内，刻意不排除**：排除它等于给「日后把 URL 改回旧路径」
    // 的人留一个盲区。代价是本文件内的注释必须避开「`api.get` 打旧前缀」这种**请求
    // 调用形态**的字面示例 —— 本文件对 `stripComments` 自身会失同步（注释不剥，见
    // 该函数说明），这类示例留在注释里会被 D6 当成真残留报出来。
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const rel = relative(SRC, file).split(sep).join('/');
      for (const m of src.matchAll(
        /\bapi\s*\.\s*(?:get|post|put|delete)\s*(?:<[^>]*>)?\(\s*(['"`])([^'"`]*)\1/g,
      )) {
        if (/^\/shelves(\/|$|\?)/.test(m[2] as string)) {
          offenders.push(`src/${rel} → ${m[2]}`);
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `发现 ${offenders.length} 处请求仍打已下线的 /shelves 前缀（后端已硬切到 ` +
          `/api/v2/iam/shelves，旧路由 404 无 alias）：\n${offenders
            .map((o) => `  ${o}`)
            .join('\n')}\n修复：把 URL 前缀改成 /iam/shelves。`,
      );
    }
    expect(offenders).toHaveLength(0);
  });
});

/** 递归收集 .ts / .vue，跳过 node_modules / __tests__ / .git。 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** 把注释逐字符替换成空格（换行保留）—— 位置全部不变，正则只在这些位置上「看不见」注释。
 *
 *  ⚠️ **不能**用「先 replace 块注释正则、再 replace 行注释正则」这种两次替换的写法
 *  （仓内另一份 spec 用的是它）：`api/shelves.ts` 的文件头行注释里写着后端映射端点
 *  的通配路径「`/api/v2/prod/shelf-processes/` + 星号」，那个星号加斜杠会被块注释
 *  正则当成块注释起点，一路吃到文件里第一处真正的块注释结束符（下面 getShelfProcesses
 *  的 JSDoc 结尾）为止 ⇒ 中间整段**真实代码**被抹成空白，D6 扫描把自己的目标文件漏掉
 *  （实测：把 `'/iam/shelves'` 改回 `'/shelves'` 后 D6 依然绿）。故这里做单趟逐字符
 *  状态机：识别普通代码 / 单双引号字符串 / 模板字符串 / 行注释 / 块注释 五态，只把
 *  后两种抹成空格。
 *
 * 模板字符串只按「整段字符串」处理（不解析 `${}` 内的表达式）：URL 字面量从不跨
 * `${}` 边界，写成 `` `/iam/shelves/${id}/update` `` 时前缀仍在开头那一段里，
 * 整段当字符串处理不影响本用例的判据。
 *
 * 正则字面量不单独识别，是已知的刻意收窄。**失同步方向只有一个：注释没被剥掉** ——
 * 正则里的引号（典型如 D6 用的引号捕获组 `(['"`])`）会把状态机带进「字符串态」跑飞，
 * 该文件此后的注释一律保留原文。影响面是「任何含引号的正则都会让该文件后续注释全部
 * 不剥」，本文件自身就是其中之一（自己的扫描正则即触发点）。
 *
 * 后果只有**误报**：那些文件里若出现打旧前缀的请求调用形态**注释示例**，D6 会把它当成
 * 真残留报出来 —— 报错信息逐条指名文件与字面量，可直接定位。
 * **不会**造成真实代码漏扫：抹白只发生在注释态，真实代码一律保留，跨全仓逐文件核对
 * 无一处 `api.<method>(` 调用被抹掉。刻意不补正则识别：那是超出本用例范围的状态机
 * 复杂度，而误报可定位、漏扫才是真风险。 */
function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blankTo = (end: number): void => {
    for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      blankTo(end);
      i = end;
    } else if (two === '/*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? src.length : end + 2;
      blankTo(end);
      i = end;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i] as string;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j += 1;
      }
      i = Math.min(j + 1, src.length);
    } else {
      i += 1;
    }
  }
  return out.join('');
}
