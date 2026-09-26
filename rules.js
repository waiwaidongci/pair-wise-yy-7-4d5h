// 业务代码一：规则
// 卷材开卷与余量核销的全部校验规则与阈值，长度单位 cm，湿度为含水率 %

export const LIMITS = {
  humidityMin: 8,    // 含水率下限 %
  humidityMax: 14,   // 含水率上限 %
  deviationCm: 0.5,  // 残长偏差阈值：过半厘米即转复核
};

export const UNFINISHED = ["预占中", "待复核"]; // 未完领料状态

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

// 领料预占前检查：长度不够、湿度越限、过期即停待复核，库存先不扣
// 返回命中的规则列表，空数组表示可直接预占
export function checkRollForRequisition(roll, requiredLength, todayStr = today()) {
  const hits = [];
  if (roll.remainingLength < requiredLength) {
    hits.push({ code: "LENGTH_SHORT", message: `长度不够：卷余 ${roll.remainingLength}cm，需 ${requiredLength}cm` });
  }
  if (roll.humidity < LIMITS.humidityMin || roll.humidity > LIMITS.humidityMax) {
    hits.push({ code: "HUMIDITY_OUT", message: `湿度越限：${roll.humidity}%，允许 ${LIMITS.humidityMin}~${LIMITS.humidityMax}%` });
  }
  if (roll.expiryDate && roll.expiryDate < todayStr) {
    hits.push({ code: "EXPIRED", message: `已过有效期：${roll.expiryDate}` });
  }
  return hits;
}

// 裁切偏差 = 实报残长 - 账面应余（账面应余 = 卷余 - 索位长度）
export function cuttingDeviation(rollRemaining, requiredLength, actualRemaining) {
  const expected = round2(rollRemaining - requiredLength);
  return { expected, deviation: round2(actualRemaining - expected) };
}

export function deviationNeedsReview(deviation) {
  return Math.abs(deviation) > LIMITS.deviationCm;
}

// 本人不能确认：复核人必须与操作人不是同一人
export function assertNotSelf(operator, reviewer) {
  if (!reviewer) throw new Error("缺少复核人");
  if (operator && operator === reviewer) throw new Error("本人不能确认，需他人复核");
}
