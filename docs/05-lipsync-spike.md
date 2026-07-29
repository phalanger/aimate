# 口型方案验证：SoulX-FlashHead vs MuseTalk

起因是两个抱怨：生成的口型视频**嘴唇颜色丢了**，后来换了素材颜色回来了，但
**嘴唇的纹路全糊了**。这篇记录换方案的验证过程和实测结论。

验证方式和麦克风那次一样：先做一个能一票否决的小实验，别急着集成。

## 一、结论

**建议换成 SoulX-FlashHead Lite。**四项实测全面优于 MuseTalk，而且集成面很小。

| | MuseTalk v1.5（现在） | SoulX-FlashHead Lite |
| --- | --- | --- |
| 稳态速度 | 25.3 FPS | **92.8 ~ 94.7 FPS** |
| 实时系数 | **0.99（几乎没余量）** | **0.27** |
| 显存峰值 | 6.90 GB | **4.96 GB** |
| 人脸像素 | 212 px | **262 px** |
| 嘴唇颜色 | 比原图淡（a −3.1） | 与原图一致（a +1.8） |
| 嘴唇纹路 | 糊成一片 | 保留 |
| 许可证 | MIT（非商用限制见其仓库） | Apache-2.0 |

最要紧的一条：**MuseTalk 现在是擦着实时线在跑**，0.947 秒生成 0.96 秒的画面，
只剩 1% 余量。任何抖动都会掉帧。FlashHead 有 3.7 倍余量。

## 二、为什么它能解决"嘴唇糊"

这不是分辨率问题，是**原理**问题。

- **MuseTalk**：把下半张脸遮掉（`half_mask=True`），再从**不含嘴部**的上下文里
  把嘴补画回去。模型没见过原来的嘴，所以嘴唇的颜色和纹路只能猜——猜出来就是
  平滑的、没有唇纹的一片。口红越重，丢得越明显。
- **FlashHead**：拿**完整参考图**生成整张脸，嘴唇有据可依。

并排图（从左到右：原图、MuseTalk、FlashHead 不裁脸、FlashHead 裁脸）：

![嘴部对比](images/05-mouth-compare.png)

原图嘴唇有竖向唇纹和清晰唇线；MuseTalk 出来是蜡质的一片，唇线也软了；FlashHead
两种模式都保住了颗粒感和唇线，裁脸那版最好。

**一个要说清楚的地方**：Laplacian 算出来的 detail 分数三者差不多（占原图
23%~28%），跟肉眼看到的差距对不上。原因是那个指标在嘴部区域上取平均，而区域里
大部分是皮肤，唇纹被平均掉了。**这已经是第四次数字误导我了，最后还是靠并排图定
的案。**

## 三、一个必须纠正的想当然

一开始我以为"FlashHead 输出 512、MuseTalk 只有 256，所以更清楚"。**这个推理是错的。**

512 是**整幅画**，256 是 MuseTalk 的**人脸裁剪**。素材都是 1024×1024，脸只占约
37%，所以直接跑：

| 图 | 源图里的脸 | 到 512 帧里 | 对比 MuseTalk 256 |
| --- | --- | --- | --- |
| 00044 | 378 px | 189 px | 0.74× |
| 00042 / 00043 | 338 px | 169 px | 0.66× |

直接跑，脸的像素**反而更少**。必须开 `--use_face_crop`，先裁脸再生成，512 才真正
花在脸上——实测人脸 262 px，比 MuseTalk 的 212 px 多 24%。

所以**默认必须开 face crop**。`face_ratio` 默认 2.0（裁脸宽的 2 倍），可调到 1.5
让脸更大，代价是构图更紧。

## 四、实测数据

RTX 4090，素材 `download/z-image-turbo_00044_.png`，音频用现成的 TTS 输出。

### 速度与显存

```text
chunk  0: 254.447s   <- 一次性 kernel 编译
chunk  1:   0.255s for 24 frames (94.0 FPS)
chunk  2:   0.253s for 24 frames (94.8 FPS)
chunk  3:   0.262s for 24 frames (91.5 FPS)
chunk  4:   0.264s for 24 frames (90.8 FPS)
output 512x512, peak VRAM 4.91 GB, steady 92.8 FPS
```

模型每次生成 33 帧、丢掉 9 帧运动帧，**净出 24 帧 = 0.96 秒画面**，所以实时的门槛
是单块 < 0.96 秒，实测 0.25 秒。

### 长时间稳定性

30 秒、768 帧连续生成：

- **身份没有漂移**——第 0 帧和第 767 帧对比，人、发型、项链、衣服、背景全部一致
- **显存平的**，峰值始终 4.96 GB，没有泄漏
- 稳态 94.7 FPS，全程不掉

### 嘴部对比

| | 画面 | 人脸像素 | 唇色 a | 相对原图 |
| --- | --- | --- | --- | --- |
| 原图 | 1024×1024 | 378 | 155.4 | — |
| MuseTalk | 576×576 | 212 | 152.3 | **−3.1** |
| FlashHead 不裁脸 | 512×512 | 196 | 156.2 | +0.8 |
| FlashHead 裁脸 | 512×512 | **262** | 157.2 | **+1.8** |

## 五、为什么不是 LatentSync

LatentSync 1.6 方向是对的——专门用 512×512 重训来解决模糊。但：

- **约 10 倍于实时**（4090 上 10 秒视频要跑 100 秒）
- 推理要 **18 GB 显存**

一句 6 秒的回复要生成约 60 秒。对话不成立，而且加上 TTS 和 Whisper 装不下 24 GB。
只有"保存视频"这种离线场景才可能用，不值得。

FlashHead 快是因为它是**蒸馏过的少步模型**（`sample_steps=4`，Self-Forcing / DMD），
不是 20~50 步的扩散。

## 六、Windows 上的坑（都已解决）

官方只写了 Linux 的装法，实际在 Windows 上：

1. **`flash_attn` 不是必须的。**代码有 `compatibility_mode` 和 `else` 两条
   `F.scaled_dot_product_attention` 兜底路径，xfuser 自己也会打日志说
   "Flash Attention library not found, using pytorch attention"。Windows 没有官方
   flash-attn wheel，这本来是最大的坑，结果不用管。
2. **requirements.txt 要裁。**`nvidia-nccl-cu12` 是 Linux-only 装不上；
   `xformers`、`decord`、`flask`、`scikit-image` **全项目一处 import 都没有**；
   `gradio` 只有 demo 用。反过来 `einops` 被 import 了却没写进去，要补。
3. **`torch.compile` 需要 Triton。**装 `triton-windows==3.3.1.post21` 就能用。
   代价是首次运行编译 254 秒，之后有缓存（再跑首块 26 秒）。**打包时要预热这个
   缓存**，否则用户第一次开口要等四分钟。
4. **`--use_face_crop` 这个参数是坏的。**argparse 写的 `type=bool`，命令行传
   `False` 会被解析成 `True`（非空字符串）。只能改代码或用 API 传真正的 bool。
5. **Pro 的权重不用下。**lite 只用 LTX VAE，`VAE_Wan` 和 `Model_Pro` 加起来 6.5 GB
   可以跳过。

## 七、下载

这台机器上下载极不稳定，实测（见 memory `download-proxy-asymmetry`）：

- **HuggingFace 走代理反而慢**：直连 8.3 MB/s，走代理 135 KB/s
- **PyTorch 相反**：直连 200 KB/s，代理 1.2 MB/s，SJTU 镜像 6 MB/s 最快
- **限速是按连接算的**：单连接 316 KB/s，四连接聚合 **18 MB/s**

所以大文件必须并行分块。用 `hf_transfer`（`HF_HUB_ENABLE_HF_TRANSFER=1` 配
`HF_ENDPOINT=https://hf-mirror.com`）6 GB 几分钟下完。

还有一个陷阱：**`huggingface-cli` 断线后会返回成功**，打印
"Returning existing local_dir as remote repo cannot be accessed"，退出码 0，留下
一个残缺文件。**不能信它的退出码，要自己核字节数。**

## 八、集成代价

比预想的小。口型服务本来就是独立进程（8930 端口），整个契约就一个方法：

```python
frames_for_audio(pcm, start_index) -> [jpeg bytes]
```

换后端 = 加一个实现了这个方法的类 + 一个独立 conda 环境（`flashhead`，
torch 2.7.1）。**主流水线、面板、渲染器一行都不用动**——当初因为 torch 版本冲突
把口型拆成独立进程，现在正好让替换变便宜。

新环境体积：权重 7.7 GB（Model_Lite 5.8 + LTX VAE 1.6 + wav2vec2 0.36）。

## 九、还没验的 / 风险

诚实列出来：

- **只测了一张图、两段音频、最长 30 秒。**不同脸型、不同光照、更长对话都没测。
- **它生成的是"整个人"，不是在真实视频上改嘴。**现在的循环视频（全身/上半身动作）
  这个概念要重新想——FlashHead 自己会生成头部小幅运动，但那是生成的，不是真实
  素材。身体大幅动作没有了。
- **构图被锁定。**开 face crop 后画面就是一张脸，适合画中画头像框，但如果想要
  半身出镜，得调 `face_ratio` 或者做合成。
- **首次编译 254 秒**必须在打包阶段预热掉。
- 中文口型没有专门验过（用的是四川话 podcast 样例和我们自己的 TTS 输出，看着对得上，
  但没做逐音节核对）。

## 十、建议

**换，但分两步：**

1. 先把 FlashHead 作为**第二个口型后端**加进去，和 MuseTalk 并存，配置里选。
   这样可以拿真实对话跑一段时间对比，出问题随时切回去。
2. 稳定之后再决定要不要把 MuseTalk 拿掉，以及循环视频那套要不要重做。

不建议直接替换，因为第九节那些没验的点里，**"整个人都是生成的"这一条是产品层面的
改变**，不是纯技术替换——得你看过实际效果才好定。
