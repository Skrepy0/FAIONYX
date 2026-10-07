# FAIONYX 外置 Yggdrasil 提供商卡片

FAIONYX 支持把提供商配置拖入启动器任意页面，或在“账号 → 外置 Yggdrasil 登录”中粘贴。导入后只会先联网识别并展示结果；用户点击“确认保存”前不会写入配置。

## 标准 JSON 格式

```json
{
  "schemaVersion": 1,
  "providerName": "Example Skin",
  "apiRoot": "https://skin.example.com/api/yggdrasil/",
  "authServer": "https://skin.example.com/api/yggdrasil/authserver/",
  "accountServer": "https://skin.example.com/api/yggdrasil/api/",
  "sessionServer": "https://skin.example.com/api/yggdrasil/sessionserver/",
  "services": "https://skin.example.com/api/yggdrasil/minecraftservices/",
  "skinDomains": ["textures.example.com", ".cdn.example.com"]
}
```

只有 `apiRoot` 必填。未提供的 Auth、Account 和 Session 端点会按 Yggdrasil 标准从 API Root 推导。支持的文件扩展名为 `.json`、`.txt`、`.url` 和 `.yggdrasil`，单个配置最大 1 MB。

## 兼容的文本与浏览器拖拽格式

- 完整或省略协议的 API Root，例如 `littleskin.cn`；省略协议时只补为 HTTPS，HTTPS 失败时绝不自动降级 HTTP。
- authlib-injector 标准拖拽 URI：`authlib-injector:yggdrasil-server:{URL 编码后的 API Root}`。
- 浏览器提供的 `text/plain` 或 `text/uri-list` URL。

FAIONYX 会跟随正常 HTTP 重定向，并处理 `X-Authlib-Injector-API-Location`（ALI）标头，再读取 API 元数据中的 `meta.serverName` 与 `skinDomains`。

## 安全行为

- 默认要求所有认证端点使用 HTTPS。HTTP 配置必须在醒目警告后由用户主动勾选确认。
- URL 中禁止嵌入用户名、密码、查询参数和片段。
- 密码只用于一次登录请求，不写入任何配置或日志。
- accessToken、refreshToken、clientToken、登录标识和用户属性使用 Electron `safeStorage` 加密；Windows 上由 DPAPI 保护。
- authlib-injector 从项目官方构件 API或其 BMCLAPI 镜像获取，下载后必须通过官方元数据提供的 SHA-256 校验才能启动。
- 皮肤与披风 URL 只会从提供商元数据声明的 `skinDomains` 下载。
