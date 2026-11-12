# Clipboard Sync

自托管的多设备剪贴板：在任意浏览器里保存文本和文件，其他设备登录后即可取用。

## 功能

- 文本与文件同步，列表每 5 秒自动刷新，支持粘贴、拖放和多选上传
- 大文件分片上传与断点续传（单文件默认上限 1 GB，单用户总量 10 GB）
- 图片、视频通过 ffmpeg 生成缩略图预览，图片可一键复制回剪贴板
- 两种登录方式：临时登录 2 小时有效，信任设备 30 天有效；长期项目和会话管理仅信任设备可用
- 临时项目保留 7 天后自动清理，长期项目不过期
- 拒绝上传可执行文件和脚本，接口按类别限流，默认启用严格 CSP

## 运行

需要 Node.js 20 及以上；预览功能需要 `ffmpeg` 在 `PATH` 中。

```bash
npm ci
cp .env.example .env   # 填写 JWT_SECRET 和初始账号
npm start              # 默认监听 http://127.0.0.1:35281
```

首次启动时会按 `DEFAULT_USERNAME` / `DEFAULT_PASSWORD` 创建账号，之后修改这两个变量不会覆盖已有用户。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JWT_SECRET` | 无，必填 | 至少 32 个字符 |
| `DEFAULT_USERNAME` / `DEFAULT_PASSWORD` | 无 | 初始账号 |
| `HOST` / `PORT` | `127.0.0.1` / `35281` | 监听地址 |
| `DATA_FILE` | `./data.json` | 用户、会话和项目元数据 |
| `UPLOAD_DIR` | `./uploads` | 上传文件目录 |
| `MAX_FILE_BYTES` | `1073741824` | 单文件上限 |
| `MAX_FILE_STORAGE_BYTES` | `10737418240` | 单用户文件总量 |
| `MAX_ITEMS` | `2000` | 单用户项目数上限 |

## 部署

- `ecosystem.config.cjs`：PM2 进程配置，数据放在 `/var/lib/clipboard-sync`
- `deployment/pm2-clipboard-sync.service`：以独立用户运行 PM2 的 systemd 单元，带文件系统与权限隔离
- `deployment/Caddyfile`：HTTPS 反向代理示例，把域名换成自己的即可

服务只监听本机地址，由反向代理对外提供 HTTPS。

## 测试

```bash
npm test
```

## 许可

[MIT](LICENSE)
