-- ============================================
-- storage: 补上 score_manager 在 sheet-music bucket 上的 UPDATE 策略
-- ============================================
--
-- 起因（pkuso-backend#59）：bucket `sheet-music` 上 INSERT / DELETE 都有 score_manager 的
-- 孪生策略，**唯独 UPDATE 只有 admin 一条**。而谱务上传用的是
-- `storage.upload(path, blob, { upsert: true })`（`pkuso-web/.../upload-modal.tsx`）——
-- 对象已存在时它走 `INSERT ... ON CONFLICT DO UPDATE`，PostgreSQL 对这条路径要求
-- **目标行的 UPDATE 策略**（SELECT 那条是公开的，不构成障碍）。于是：
--
--   · 上传（新对象）        → INSERT 策略，score_manager 通过 ✓
--   · 删除                  → DELETE 策略，通过 ✓
--   · **重试同一个路径**    → 撞 RLS 403 ✗
--
-- 撞的正是「传上去了但 insert 响应丢了 / 批量 insert 失败」之后的**逐行重试**：同一个
-- `storageId` 算出同一个路径 `{scoreId}/{storageId}.pdf`，对象还在桶里，upsert 被拒。
-- 那条幂等路径是为 admin 设计的（见 upload-modal.tsx 里「重试仍走同一条路径 + upsert」
-- 的说明），对 score_manager 一直是坏的。
--
-- 依据（**prod 实查** `pg_policies`，storage.objects / bucket = sheet-music 共 6 条）：
--   INSERT：管理员可上传乐谱（is_admin()）、score_manager can upload to sheet-music（含 score_manager）
--   DELETE：管理员可删除乐谱（is_admin()）、score_manager can delete from sheet-music（含 score_manager）
--   UPDATE：管理员可更新乐谱（is_admin()）                      ← **只有这一条，缺口在这**
--   SELECT：所有人可读取 sheet-music（bucket_id = 'sheet-music'）
--
-- ⚠️ 这条缺口我只做到「策略集 + upsert 语义」的推理，**没有用 score_manager 身份真跑一次覆盖**
--    （那要在 dev 上造账号并上传，属写实验，见 issue 里的复现步骤）。补这条策略本身是安全的：
--    score_manager 在这个 bucket 上本来就能 INSERT 与 DELETE，UPDATE 只是补齐「同一把钥匙的第三道门」。
--
-- ⚠️ **为什么新增一条而不是改 `管理员可更新乐谱`**：`20260922000001` 当初也走「新增孪生策略」
--    （`score_manager can upload/delete sheet-music`）而不是改 admin 那三条 —— 保持一致；
--    改既有策略会让「谁在什么时候为什么放开」这段历史从迁移里消失。
--
-- 回滚：
--   DROP POLICY IF EXISTS "score_manager can update sheet-music" ON storage.objects;

BEGIN;

CREATE POLICY "score_manager can update sheet-music" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'sheet-music' AND (
      is_admin() OR
      (SELECT role = 'score_manager' FROM profiles WHERE id = auth.uid())
    )
  );

COMMIT;
