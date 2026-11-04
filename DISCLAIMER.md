# 免责声明 / Disclaimer

> 使用本项目（含脚本、文档、调研与工具）前请完整阅读。**下载、安装或运行即视为你已理解并接受以下全部内容。**

## 1. 项目性质

- 本项目是**个人学习与技术研究**产物，用于研究 Web 自动化、DOM 差异适配与前端反爬机制，
  **不是**任何平台或学校的官方工具，与超星 / 学习通及其关联方无任何关系。
- 项目按「现状」提供，作者**不承诺**它现在能用、将来还能用。平台一次前端改版就可能让它完全失效，
  且不保证会被修复。
- 项目不提供任何形式的商业服务、代刷服务或账号交易。

## 2. 使用风险由你承担

自动化访问可能触发平台的风控机制，包括但不限于：要求人脸核验、弹出图形验证码、
限制访问、清空或判定任务点无效、记录异常行为、影响课程成绩或学籍处理。

**这些后果由使用者自行承担。** 作者与贡献者不对以下任何一项负责：

- 账号被限制、封禁、风控标记，或需要人工核验；
- 课程任务点 / 成绩被判定无效、清零、重修；
- 因使用本项目导致的学业处罚、纪律处分或其他间接损失；
- 数据丢失、设备异常、时间损失。

**请自行评估**：涉及正式学分与成绩的课程，建议手动完成，不要用于任何有真实风险的场合。

## 3. 合规要求

- 你应当自行遵守超星 / 学习通的服务条款，以及你所在学校的教学管理规定。
- 本项目**不提供、也不接受**下列功能（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）：
  绕过或模拟人脸识别、破解验证码、伪造接口 / 心跳 / 观看时长、
  「秒刷」直接标记完成、考试自动交卷、多端并发刷同一账号。
- 请不要把本项目用于代替自己学习。它的定位是「把重复的播放操作自动化」，
  而不是「不学也能过」。

## 4. 数据处理与隐私

- 脚本**不包含**任何收集、上报、回传导航数据的功能，也没有作者控制的服务器。
  你的配置、题库、断点、日志全部保存在**你自己浏览器**的脚本管理器存储里。
- **需要你知情的一点**：如果你启用了「AI 答题」，脚本会把**题目文本**通过 HTTPS
  发送到**你自己配置的**AI 服务商（如 DeepSeek），并附带你自己的 API Key。
  这一行为由你主动开启，数据流向该服务商而非作者；是否合规取决于该服务商的条款与你的选择。
- 脚本不会读取、上传或存储你的平台账号密码；登录态由浏览器自身维护。

## 5. 许可与上游声明

- 本项目以 [MIT](LICENSE) 许可发布，署名：**mahe-404**（原始作者）、**LUgABeEEE**（v3.0.0 – v4.0.1 改造）。
- 本项目衍生自上游仓库，**上游未附带明确的许可证文件**。若原作者对当前的署名或许可方式有异议，
  请通过仓库 issue 联系，我们会立即调整或移除相关内容。
- MIT 许可是「无担保」许可：作者不提供任何明示或暗示的担保（含适销性、特定用途适用性、不侵权）。

## 6. 第三方内容

`research/` 目录下的调研文档引用了第三方项目的公开信息（README、issue、源码片段），
版权归各自作者所有，仅作技术研究与比较之用。引用处均尽可能给出链接。
若你认为某处引用不当，请联系删除。

---

## English summary

This project is an unofficial, personal research tool for automating repetitive playback on
Chaoxing / Xuexitong course pages. It is provided **as-is**, with **no warranty** and **no
guarantee of continued functionality**. Using it may trigger the platform's anti-automation
measures (CAPTCHA, face verification, restrictions) and may affect your course progress or
standing; **you bear that risk entirely**. The authors and contributors accept no liability.

The script collects and transmits **no data** to the authors. If you enable the optional AI
answering feature, question text is sent to the AI provider **you** configure, using **your**
API key.

The project deliberately does **not** include — and will not accept — features that bypass
security measures (face verification, CAPTCHA), forge API calls or watch time, auto-submit exams,
or run multiple sessions against one account. Please also comply with the platform's terms of
service and your institution's academic rules.

Licensed under [MIT](LICENSE) © 2026 mahe-404 (original author) and LUgABeEEE. This work is derived from an upstream
repository that does not carry an explicit license file; if the original author objects to the
current attribution or licensing, please open an issue and it will be adjusted or removed.
