// 业务代码二：卷材档案
// 每卷登记批号、长度、湿度和有效期；负责开卷登记、档案查询与余额视图

import { round2 } from "./rules.js";

export function registerRoll(db, input, operator) {
  const roll = {
    id: "R-" + Date.now(),
    batchNo: (input.batchNo || "").trim(),
    material: input.material || "蜡线",
    totalLength: Number(input.totalLength),
    remainingLength: round2(Number(input.totalLength)),
    humidity: Number(input.humidity),
    expiryDate: input.expiryDate,
    status: "在库", // 在库 / 占用中 / 用完
    currentRequisitionId: null,
    createdBy: operator || "未登记",
    createdAt: new Date().toISOString(),
    logs: [],
  };
  if (!roll.batchNo) throw new Error("缺少批号");
  if (db.rolls.some(r => r.batchNo === roll.batchNo)) throw new Error("批号已存在：" + roll.batchNo);
  if (!(roll.totalLength > 0)) throw new Error("登记长度必须大于 0");
  if (!(roll.humidity >= 0)) throw new Error("湿度必须为非负数值");
  if (!roll.expiryDate) throw new Error("缺少有效期");
  roll.logs.push({
    at: roll.createdAt,
    step: "开卷登记",
    note: `批号 ${roll.batchNo}，${roll.totalLength}cm，湿度 ${roll.humidity}%，有效期至 ${roll.expiryDate}`,
  });
  db.rolls.unshift(roll);
  return roll;
}

export function findRoll(db, idOrBatch) {
  return db.rolls.find(r => r.id === idOrBatch || r.batchNo === idOrBatch);
}

// 余额视图：每卷已核销与剩余，加总余额
export function balanceView(db) {
  const rows = db.rolls.map(r => ({
    id: r.id,
    batchNo: r.batchNo,
    material: r.material,
    totalLength: r.totalLength,
    used: round2(r.totalLength - r.remainingLength),
    remainingLength: r.remainingLength,
    status: r.status,
  }));
  return { rows, totalRemaining: round2(rows.reduce((s, r) => s + r.remainingLength, 0)) };
}
