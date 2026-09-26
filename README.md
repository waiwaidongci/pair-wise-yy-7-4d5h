# 古船模型帆索校准

运行：

```bash
npm start
```

访问`http://localhost:3038`。

## 卷材开卷与余量核销

- 业务代码：规则 `RG-xxxx`、卷材档案 `RL-xxxx`、领料/裁切操作 `OP-xxxx`，各自连续编号。
- 卷材档案：每卷登记批号、开卷长度、湿度、有效期。
- 领料按索位长度预占，一卷只接一份未完领料（预占中/待确认/待复核均占卷）。
- 长度不够、湿度越限（默认 40–60%，规则可调）或过期即停待复核，库存先不扣。
- 裁切后登记实裁长度、残长和接头数；残长与账面余额偏差超过 0.5cm 自动转复核。
- 本人不能确认/复核本人单据（领料人、裁切人均受限），须他人办理。
- 页面展示余额合计、待处理队列和每卷占用模型（余额/预占/可用）。

主要接口：`GET /api/ledger`、`POST /api/rolls`、`POST /api/requisitions`、`POST /api/operations/:code/cut`、`POST /api/operations/:code/confirm`、`POST /api/operations/:code/review`、`PATCH /api/rules/:code`。

数据保存在：

- `data/model-rigging-calibration.json`（模型校准）
- `data/rigging-roll-ledger.json`（卷材台账）
