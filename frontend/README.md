# OpenCode Skills Frontend

基于 Vue 3 + Vite + TypeScript 的现代化前端应用。

## 技术栈

- **框架**: Vue 3 (Composition API)
- **构建工具**: Vite 5
- **语言**: TypeScript
- **状态管理**: Pinia
- **样式**: Tailwind CSS
- **测试**: Vitest + Vue Test Utils
- **代码规范**: ESLint + Prettier

## 开发环境

### 前置要求

- Node.js 18+
- npm 9+

### 安装依赖

```bash
cd frontend
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:4101

### 使用 Docker 开发

```bash
# 在项目根目录
docker compose --profile dev up frontend-dev
```

## 构建生产版本

```bash
npm run build
```

构建产物将输出到 `dist/` 目录。

## 项目结构

```
frontend/
├── src/
│   ├── components/           # Vue 组件
│   │   ├── layout/          # 布局组件
│   │   ├── jobs/            # 任务相关组件
│   │   ├── editor/          # 编辑器组件
│   │   ├── results/         # 结果展示组件
│   │   └── human/           # 人工验证组件
│   ├── composables/         # 可组合函数
│   ├── stores/              # Pinia 状态管理
│   ├── types/               # TypeScript 类型定义
│   ├── utils/               # 工具函数
│   ├── App.vue              # 根组件
│   └── main.ts              # 入口文件
├── public/                  # 静态资源
├── index.html               # HTML 模板
├── vite.config.ts           # Vite 配置
├── tsconfig.json            # TypeScript 配置
├── tailwind.config.js       # Tailwind CSS 配置
└── package.json             # 项目配置
```

## 开发指南

### 组件开发

1. 在 `src/components/` 下创建组件
2. 使用 `<script setup lang="ts">` 语法
3. 使用 Tailwind CSS 进行样式设计
4. 遵循 Vue 3 Composition API 最佳实践

### 状态管理

使用 Pinia 进行状态管理：

```typescript
import { useJobStore } from '@/stores/jobStore'

const jobStore = useJobStore()
```

### API 调用

使用 `useApi` composable 进行 API 调用：

```typescript
import { useApi } from '@/composables/useApi'

const api = useApi()
const data = await api.get('/jobs')
```

### 实时更新

使用 `useSSE` composable 进行 Server-Sent Events 通信：

```typescript
import { useSSE } from '@/composables/useSSE'

const { events, connectionStatus } = useSSE(jobId)
```

## 测试

### 单元测试

```bash
npm run test:unit
```

### 集成测试

```bash
npm run test:e2e
```

## 代码规范

### ESLint

```bash
npm run lint
```

### Prettier

```bash
npm run format
```

## 部署

### Docker 构建

```bash
# 在项目根目录
docker build -f frontend/Dockerfile -t opencode-skills-frontend ./frontend
```

### 生产部署

1. 构建前端: `npm run build`
2. 将 `dist/` 目录部署到 Web 服务器
3. 配置反向代理指向后端 API

## 故障排除

### 开发服务器无法启动

1. 检查端口 4101 是否被占用
2. 确认所有依赖已安装: `npm install`
3. 检查 Node.js 版本是否符合要求

### API 连接失败

1. 确认后端服务正在运行
2. 检查 `API 地址` 配置是否正确
3. 查看浏览器控制台错误信息

### 构建失败

1. 运行 `npm run lint` 检查代码规范
2. 检查 TypeScript 类型错误
3. 查看完整错误信息

## 贡献指南

1. 创建功能分支: `git checkout -b feature/amazing-feature`
2. 提交更改: `git commit -m 'Add amazing feature'`
3. 推送到分支: `git push origin feature/amazing-feature`
4. 创建 Pull Request

## 许可证

MIT License
