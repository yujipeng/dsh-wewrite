/**
 * K 组 任务中心（Task Center）——3 条。
 * K01 fresh：任务页空态与导航可达性（不依赖生成）。
 * K02 live：启动两个生成任务 → 串行队列出现「排队中」→ 取消排队任务 → 取消运行任务 →
 *          两条都进入「最近完成·已取消」。
 * K03 live：展开最近完成行 → run/detail 六步 + 重试入口。
 *
 * 依赖：K02/K03 需要 G05 已配模型（与 H 组同一 live 前提）；不额外点击重试，避免重复 LLM 预算。
 */
import {
  assert,
  clickTab,
  expectPresent,
  expectVisible,
  gotoWorkbench,
  LOC,
  pollUntil,
} from '../lib.mjs';

async function startRunFromRail(page, topic) {
  await gotoWorkbench(page);
  await page.locator('.ww-rail__new').first().click();
  const form = page.locator(LOC.railNewForm).first();
  await form.waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="ww-rail-new-input"]').first().fill(topic);
  await page.locator('[data-testid="ww-rail-new-submit"]').first().click();
  await expectVisible(page.getByText(`正在生成《${topic}》`).first(), {
    timeout: 15000,
    msg: `提交后应出现生成 overlay（${topic}）`,
  });
  // 转入后台：右下进度卡接管，任务页可继续操作。
  await page.getByRole('button', { name: /转入后台/ }).first().click();
  await pollUntil(async () => (await page.getByText(`正在生成《${topic}》`).count()) === 0, {
    timeout: 6000,
    msg: '转入后台后 overlay 应收起',
  });
}

export default [
  {
    id: 'K01',
    group: 'K 任务中心',
    phase: 'fresh',
    // 前置：fresh（空 unit，无 run 历史）。
    // 步骤：顶栏进入「任务」。
    // 断言：任务页容器与页头存在；无任务时展示空态文案；不出现运行中/排队中分组。
    fn: async (page) => {
      await clickTab(page, 'tasks');
      await expectVisible(page.locator('.ww-tasks').first(), { msg: '任务页容器 .ww-tasks 未渲染' });
      assert.ok(
        (await page.locator('.ww-pagebar__title').getByText('任务').count()) > 0,
        '任务页页头应显示「任务」',
      );
      await expectVisible(page.getByText('还没有任务。开始一篇写作后，运行中、排队中和最近完成都会在这里留痕。').first(), {
        timeout: 6000,
        msg: '空态文案未出现',
      });
      assert.equal(await page.getByText('运行中（').count(), 0, '空态不应出现运行中分组');
      assert.equal(await page.getByText('排队中（').count(), 0, '空态不应出现排队中分组');
    },
  },
  {
    id: 'K02',
    group: 'K 任务中心',
    phase: 'live',
    // 前置：live；G05 已配模型。
    // 步骤：启动 A（转入后台）→ 启动 B（转入后台）→ 任务页观察 → 取消 B → 取消 A。
    // 断言：B 在排队中分组；取消后最近完成出现「已取消」；A 同样可取消并进入最近完成。
    fn: async (page) => {
      const topicA = '任务中心排队 A';
      const topicB = '任务中心排队 B';
      await startRunFromRail(page, topicA);
      await startRunFromRail(page, topicB);

      await clickTab(page, 'tasks');
      await expectVisible(page.locator('.ww-tasks').first(), { msg: '任务页未渲染' });

      const queuedGroup = page.locator('.ww-tasks__group', { hasText: '排队中' }).first();
      await expectVisible(queuedGroup, { timeout: 15000, msg: '串行队列下第二个任务应出现在「排队中」分组' });
      assert.ok(
        (await queuedGroup.getByText(topicB).count()) > 0,
        `排队中分组应包含第二个任务《${topicB}》`,
      );

      // 取消排队任务：立即出队，不启动。
      await queuedGroup.getByRole('button', { name: '取消' }).first().click();
      await pollUntil(
        async () => (await page.locator('.ww-tasks__group', { hasText: '排队中' }).count()) === 0,
        { timeout: 8000, msg: '取消排队任务后「排队中」分组应消失' },
      );
      const recentGroup = page.locator('.ww-tasks__group', { hasText: '最近完成' }).first();
      await pollUntil(
        async () => (await recentGroup.getByText('已取消').count()) > 0,
        { timeout: 8000, msg: '被取消的排队任务应进入最近完成并显示「已取消」' },
      );
      assert.ok((await recentGroup.getByText(topicB).count()) > 0, `最近完成应包含《${topicB}》`);

      // 清理运行中的 A，避免遗留长任务。
      const runningGroup = page.locator('.ww-tasks__group', { hasText: '运行中' }).first();
      if ((await runningGroup.count()) > 0) {
        await runningGroup.getByRole('button', { name: '取消' }).first().click();
      }
      await pollUntil(async () => (await page.locator('.ww-tasks__group', { hasText: '运行中' }).count()) === 0, {
        timeout: 15000,
        msg: '取消运行中任务后「运行中」分组应消失',
      });
    },
  },
  {
    id: 'K03',
    group: 'K 任务中心',
    phase: 'live',
    // 前置：K02 已留下 cancelled 记录。
    // 步骤：任务页 → 最近完成行点「详情」。
    // 断言：run/detail 六步标签出现；cancelled 行提供「重试」入口。
    fn: async (page) => {
      await clickTab(page, 'tasks');
      const recentGroup = page.locator('.ww-tasks__group', { hasText: '最近完成' }).first();
      await expectVisible(recentGroup, { timeout: 8000, msg: '最近完成分组未出现（K02 应已留下记录）' });

      await recentGroup.getByRole('button', { name: '详情' }).first().click();
      for (const label of ['选题分析', '研究与提纲', '初稿写作', '质量门禁', '排版转换', '配图生成']) {
        await expectVisible(page.locator('.ww-task__steps').getByText(label, { exact: true }).first(), {
          timeout: 6000,
          msg: `详情六步缺「${label}」`,
        });
      }
      await expectPresent(recentGroup.getByRole('button', { name: '重试' }), '最近完成行应提供重试入口');
    },
  },
];
