# 小小积分银行 — 账号云同步后端镜像（零依赖）
# 适用于 任意支持 Docker 的容器平台（微信云托管 / Railway / Render / 自建）
FROM node:18-alpine
WORKDIR /app
COPY package.json server.js kids-points.html ./
RUN npm install --omit=dev || true
ENV DATA_DIR=/data PORT=80
VOLUME ["/data"]
EXPOSE 80
CMD ["node", "server.js"]
