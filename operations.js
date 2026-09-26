// 业务代码三：操作
// 领料预占、裁切登记、复核确认，以及待处理与占用模型视图

import {
  LIMITS, UNFINISHED,
  checkRollForRequisition, cuttingDeviation, deviationNeedsReview,
  assertNotSelf, round2,
} from "./rules.js";
import { findRoll } from "./rolls.js";

export function findRequisition(db, id) {
  return db.requisitions.find(q => q.id === id);
}

function now() { return new Date().toISOString(); }

// 领料预占：一卷只接一份未完领料；命中规则即停待复核，库存先不扣
export function createRequisition(db, input) {
  const roll = findRoll(db, input.rollId);
  if (!roll) throw new Error("卷材不存在：" + input.rollId);
  if (roll.status === "用完") throw new Error("卷材已用完：" + roll.batchNo);
  const requiredLength = Number(input.requiredLength);
  if (!(requiredLength > 0)) throw new Error("索位长度必须大于 0");
  if (!input.position) throw new Error("缺少索位");
  const open = db.requisitions.find(q => q.rollId === roll.id && UNFINISHED.includes(q.status));
  if (open) throw new Error(`一卷只接一份未完领料：${roll.batchNo} 已有${open.status}单 ${open.id}`);
  const hits = checkRollForRequisition(roll, requiredLength);
  const req = {
    id: "Q-" + Date.now(),
    rollId: roll.id,
    position: input.position,
    requiredLength,
    operator: input.operator || "未登记",
    status: hits.length ? "待复核" : "预占中",
    ruleHits: hits,
    cutting: null,
    createdAt: now(),
    logs: [],
  };
  if (hits.length) {
    req.logs.push({ at: now(), step: "停待复核", note: hits.map(h => h.message).join("；") + "；库存先不扣" });
  } else {
    occupy(roll, req);
    req.logs.push({ at: now(), step: "预占", note: `${req.position} 预占 ${requiredLength}cm，库存先不扣` });
  }
  db.requisitions.unshift(req);
  return req;
}

function occupy(roll, req) {
  roll.currentRequisitionId = req.id;
  roll.status = "占用中";
  roll.logs.push({ at: now(), step: "预占", note: `${req.id} · ${req.position} · ${req.requiredLength}cm` });
}

// 领料复核：通过则转为预占，驳回则取消；本人不能确认
export function reviewRequisition(db, reqId, input) {
  const req = findRequisition(db, reqId);
  if (!req) throw new Error("领料单不存在：" + reqId);
  if (req.status !== "待复核" || req.cutting) throw new Error("该单不在待复核状态");
  assertNotSelf(req.operator, input.reviewer);
  const roll = findRoll(db, req.rollId);
  if (input.decision === "通过") {
    req.status = "预占中";
    occupy(roll, req);
    req.logs.push({ at: now(), step: "复核通过", note: `${input.reviewer} 放行（${req.ruleHits.map(h => h.code).join("/")}）` });
  } else {
    req.status = "已取消";
    req.logs.push({ at: now(), step: "复核驳回", note: `${input.reviewer} 驳回，领料取消` });
  }
  return req;
}

// 裁切登记：登记残长和接头数，偏差过半厘米转复核，否则直接核销
export function registerCutting(db, reqId, input) {
  const req = findRequisition(db, reqId);
  if (!req) throw new Error("领料单不存在：" + reqId);
  if (req.status !== "预占中") throw new Error("该单不在预占中，不能裁切");
  const roll = findRoll(db, req.rollId);
  if (roll.currentRequisitionId !== req.id) throw new Error("卷材占用与领料单不一致");
  const actualRemaining = Number(input.actualRemaining);
  const joints = Number(input.joints ?? 0);
  if (!(actualRemaining >= 0)) throw new Error("残长不能为负");
  if (actualRemaining > roll.remainingLength) throw new Error(`残长 ${actualRemaining}cm 大于卷余 ${roll.remainingLength}cm`);
  if (!(joints >= 0)) throw new Error("接头数不能为负");
  const { expected, deviation } = cuttingDeviation(roll.remainingLength, req.requiredLength, actualRemaining);
  const needReview = deviationNeedsReview(deviation);
  req.cutting = {
    actualRemaining,
    joints,
    expectedRemaining: expected,
    deviation,
    cutBy: input.operator || req.operator,
    cutAt: now(),
    status: needReview ? "待复核" : "已确认",
    confirmedBy: needReview ? null : `系统(偏差≤${LIMITS.deviationCm}cm)`,
    confirmedAt: needReview ? null : now(),
  };
  if (needReview) {
    req.status = "待复核";
    req.logs.push({ at: now(), step: "裁切待复核", note: `残长 ${actualRemaining}cm，偏差 ${deviation}cm 超过 ${LIMITS.deviationCm}cm，待他人复核后核销` });
  } else {
    settle(req, roll);
    req.logs.push({ at: now(), step: "裁切核销", note: `残长 ${actualRemaining}cm，接头 ${joints} 个，偏差 ${deviation}cm` });
  }
  return req;
}

// 裁切复核：通过按实报残长核销，驳回退回预占重新裁切；本人不能确认
export function reviewCutting(db, reqId, input) {
  const req = findRequisition(db, reqId);
  if (!req || !req.cutting) throw new Error("裁切记录不存在：" + reqId);
  if (req.cutting.status !== "待复核") throw new Error("该裁切记录不在待复核状态");
  assertNotSelf(req.cutting.cutBy, input.reviewer);
  const roll = findRoll(db, req.rollId);
  if (input.decision === "通过") {
    req.cutting.status = "已确认";
    req.cutting.confirmedBy = input.reviewer;
    req.cutting.confirmedAt = now();
    settle(req, roll);
    req.logs.push({ at: now(), step: "复核通过", note: `${input.reviewer} 确认，按残长 ${req.cutting.actualRemaining}cm 核销` });
  } else {
    req.cutting.status = "已驳回";
    req.status = "预占中";
    req.logs.push({ at: now(), step: "复核驳回", note: `${input.reviewer} 驳回，退回预占重新裁切` });
  }
  return req;
}

// 核销：按实报残长扣减库存，释放卷材
function settle(req, roll) {
  const c = req.cutting;
  const consumed = round2(roll.remainingLength - c.actualRemaining);
  roll.remainingLength = c.actualRemaining;
  roll.currentRequisitionId = null;
  roll.status = roll.remainingLength <= 0 ? "用完" : "在库";
  req.status = "已完成";
  roll.logs.push({ at: now(), step: "核销", note: `${req.id} 裁用 ${consumed}cm，接头 ${c.joints} 个，余 ${roll.remainingLength}cm` });
}

// 待处理视图：规则停待复核的领料 + 偏差待复核的裁切
export function pendingView(db) {
  const items = [];
  for (const req of db.requisitions) {
    const roll = findRoll(db, req.rollId);
    if (req.status === "待复核" && !req.cutting) {
      items.push({
        kind: "领料复核", id: req.id, batchNo: roll?.batchNo, position: req.position,
        operator: req.operator, reason: req.ruleHits.map(h => h.message).join("；"),
      });
    }
    if (req.cutting?.status === "待复核") {
      items.push({
        kind: "裁切复核", id: req.id, batchNo: roll?.batchNo, position: req.position,
        operator: req.cutting.cutBy,
        reason: `残长 ${req.cutting.actualRemaining}cm，偏差 ${req.cutting.deviation}cm 超过 ${LIMITS.deviationCm}cm`,
      });
    }
  }
  return items;
}

// 占用模型：每卷被哪份领料占用、占多少、还可用多少
export function occupancyView(db) {
  return db.rolls.map(roll => {
    const req = roll.currentRequisitionId ? findRequisition(db, roll.currentRequisitionId) : null;
    const occupied = req && UNFINISHED.includes(req.status) ? req.requiredLength : 0;
    return {
      id: roll.id,
      batchNo: roll.batchNo,
      status: roll.status,
      remainingLength: roll.remainingLength,
      occupiedBy: occupied
        ? { id: req.id, position: req.position, requiredLength: req.requiredLength, operator: req.operator, status: req.status }
        : null,
      available: round2(roll.remainingLength - occupied),
    };
  });
}
