# QQ 纪念账号风格草案工具（失败版）

这是一个经授权使用的 QQ 群聊风格分析和纪念账号回复草案工具。纪念账号不是被纪念者本人，不能代表本人作出承诺、陈述经历或伪造记忆；系统只可借鉴获授权样本中的语言风格。
实际测试未通过，故未发布。花了我很多时间（以及token），但最终效果不佳，放弃了。上传到github是为了记录下开发过程，顺便留给后人一些警示（。

## 功能边界

- `collect` 可采集指定 QQ 的群聊记录；是否保存原始消息由配置控制，默认应保持关闭。
- `analyze` 从获授权的最小化聊天记录生成风格 Profile。`--file` 可指定文件；未指定时仅选择目标 QQ 最新匹配的记录。
- `test` 调用 `ReplyEngine` 的 dry-run：仅展示将发送给模型的请求和检索信息，不调用模型、不生成候选、不发送消息。
- `imitate` 只生成经过安全校验的回复草案，绝不直接发送 QQ 消息；传入 `--dry-run` 时同样不调用模型。
- runtime 和主动参与默认关闭。即使账号已经授权，也必须在受控运行时中另行显式启用，并限制在已授权群范围内。

当前不提供自动启用运行时、自动加入或主动发言、绕过授权采集、将草案直接发送到 QQ，或把纪念账号伪装为本人。

## 配置

```bash
cp config/config.example.json config/config.json
```

除非已取得适当授权并完成数据处理评估，保留示例配置中的默认关闭状态：原始消息保存、runtime 和主动参与均不启用。身份披露应在纪念账号记录中明确配置；即便未配置，回复引擎仍禁止声称自己是被纪念者本人。

## 命令行

```bash
# 安装依赖
npm install

# 采集。默认不保存原始消息。
npm run collect -- --group <群号> --user <QQ号>

# 分析已获授权的最小化数据
npm run analyze -- --user <QQ号>

# 或指定数据文件；相对路径按项目根目录解析
npm run analyze -- --user <QQ号> --file data/raw/<文件名>.json

# ReplyEngine dry-run：不调用模型，不发送消息
npm run test -- --user <QQ号> --message "今天天气真好" --group <群号>

# 生成草案但不发送；--dry-run 仅预览模型请求
npm run imitate -- --user <QQ号> --message "今天天气真好" --group <群号>
npm run imitate -- --user <QQ号> --message "今天天气真好" --dry-run

# 查看 Profile
npm run show -- --user <QQ号>

# 启动受控实时运行时。仍会逐条检查授权、群范围、开关、冷却与敏感话题。
npm run run -- --id memorial-example --mode mention_only
```

`npm run imitate` 已对应 CLI 的 `imitate` 命令。CLI 会把工作目录固定为项目根目录，因此可从其他工作目录调用 `node <项目路径>/src/cli.js ...`；传给 `--file` 的相对路径仍以项目根目录为基准。

## 纪念账号治理

纪念账号创建后处于 `pending` 状态，且 runtime 与主动参与默认关闭。`authorize` 只改变授权状态，不会自动打开运行开关；`pause` 会暂停账号并关闭这两个开关。创建、授权、暂停和删除操作均写入审计记录。

```bash
# 创建待授权纪念账号，并限制未来允许参与的群范围
node src/cli.js memorial create \
  --id memorial-example \
  --name "小明纪念账号" \
  --subject-qq <QQ号> \
  --group <群号> \
  --disclosure "这是纪念账号生成的回复，不代表本人。" \
  --actor <操作者>

# 记录授权；不会启用 runtime 或主动参与
node src/cli.js memorial authorize --id memorial-example --actor <操作者> --reason "授权已核验"

# 首次启用前再次核验授权、群范围和身份披露；--confirm 是必要的二次确认
node src/cli.js memorial enable --id memorial-example --actor <操作者> --confirm

# 启动实时运行时；首次建议只响应 @机器人
npm run run -- --id memorial-example --mode mention_only

# 需要暂停时关闭 runtime 与主动参与
node src/cli.js memorial pause --id memorial-example --actor <操作者>

# 查看审计记录
node src/cli.js memorial audit --id memorial-example

# 删除关联样本并软删除账号；仅在保留策略允许时使用 --hard
node src/cli.js memorial delete --id memorial-example --actor <操作者>
```

授权状态不等于允许发言。实际参与还需要运行时、主动参与开关、群范围和参与策略同时允许；这些限制由 `GovernanceService` 与运行时策略执行。

## 测试

```bash
node --test
node --check src/cli.js
```

## Web 界面

```bash
npm run web
```

访问 `http://localhost:3080`。Web 界面用于配置和 Profile 查看，不替代纪念账号的授权、治理或受控运行时流程。
