# 板书规则参考

参考 learning_task 的 System / User 示例。保留原始来源，以下节选用于制定本地板书协议；本地原型不声称已实现原平台全部教具组件。

## System

来源：/Users/wsy/Review_Lessons/learning_task/docs/新知课示例/数据资料/main_prompt/system.md

## 板书操作
### 原则
- **服务讲解**：板书是工具而非目的，应根据讲解要求合理挑选使用板书，不需要可以不使用
- **紧密配合发言**：在不泄露答案的前提下，与发言能紧密配合，边讲边操作。
- **防剧透**：不要提前展示包含答案的板书组件，尤其在提问时。

### 格式
具体参考加载的组件手册

## User 板书手册

来源：/Users/wsy/Review_Lessons/learning_task/docs/练习任务详情结构对比/98571-r15-完整User.md

[环节信息]
<板书使用手册>
## 板书布局使用手册
使用板书布局指令来添加和移除板书区域中的内容。

通用指令格式：
`<document-operation action="{方法}" id="{组件ID}" [...其他属性] />`

### 将组件添加到板书区域
将 `prefabs` 内的一个组件添加到板书区域内，以便展示和操作组件

指令：<document-operation action="add" role="{教学语义角色}" component="{组件类型}" id="{组件ID}" [belowOf="{组件ID}" | rightOf="{组件ID}"] />

规则：
- 需要指定布局关系（`belowOf` / `rightOf`），严格遵循【板书区域布局关系】
- 添加首个组件时，因为板书区域为空，不需要指定布局关系
- 部分板书组件有预制的相对关系，只需将父组件添加到板书区域内，其内部的组件会一并被添加进来
- `component` 属性填写组件的类型名称（如 `image`、`interaction`、`travel-graph`、`textblock`、`group` 等）
- 需要指定教学语义角色 `role`，前端会按 role 呈现不同的样式

```yaml
role:
  -
    value: title
    intention: 写标题。每个**新教学环节/小节**的开头，告诉学生"我们现在学什么"
  -
    value: question
    intention: 出题/呈现题目、条件、材料。
  -
    value: process
    intention: 展示推理过程，**老师带着学生做**的计算步骤、推导过程、解题路径（讲完可以移除）
  -
    value: knowledge
    intention: 写知识点，如核心定义、公式、方法技巧、归纳结论（需要一直留在板书上）
  -
    value: note
    intention: 写辅助信息，如注意事项、易错点、关键变化标注、提示、课堂学习计划
  -
    value: student-answer
    intention: 展示学生的作答，把学生的答案呈现在板书上供点评
  -
    value: student-process
    intention: 展示学生的思考过程，把学生的解题推理呈现出来供分析
  -
    value: student-question
    intention: 展示学生的反问，把学生提出的疑问呈现出来供解答
```

板书区域布局关系：
- 上下布局`belowOf="ID"`：排在某个组件的 **下方**，独占新一行
- 左右布局`rightOf="ID"`：排在某个组件的 **右侧**，宽度随内容自适应，高度按同行最大值对齐

### 移除组件
将组件（以及其子组件）从板书区域内移除

指令：<document-operation action="remove" id="{组件ID}" />

### 高亮组件
高亮用于牵引学生注意力，按范围分为两种类型：
- **局部高亮**：用组件自身的 highlight 指令`<call-{component-name} id="{组件ID}" action="highlight" intent="{reference|inquiry|emphasis}" [...] />`，详见【板书组件使用手册】对应说明，高亮组件**内部的特定元素**（某些文本、某个节点、某条路径等）
- **整体高亮**：用 `<document-operation action="highlight" id="{组件ID}" intent="{reference|inquiry|emphasis}" />`，高亮**整个组件**（教具、图片等）

两种类型都必须提供 `intent` 属性，说明高亮的教学意图。

#### 高亮意图 intent
根据高亮的教学意图，从 `reference` | `inquiry` | `emphasis` 中选择，前端会呈现对应的视觉信号：
- **reference（提及）**：定位注意力，表示"看这里"。典型场景：顺带指示、同步视线、刚写下板书时指读。视觉：轻微变化
- **inquiry（提问）**：激活思考，表示"想一想"。典型场景：针对内容提问、引导观察、邀请填空/计算。视觉：持续动态变化（如呼吸、晃动）直至学生开始回答
- **emphasis（强调）**：巩固记忆，标记内容的重要性，表示"这个很关键"。典型场景：总结结论、标记易错点、揭晓答案后。视觉：强烈静态标记（如变色、加粗）并持久留存

#### 区别与使用优先级
局部高亮能为学生标出具体的关键信息，**信息量高于**整体高亮。选择高亮方式时，遵循以下优先级：
1. **优先使用局部高亮**：当组件内有可以标出的关键元素时，用组件自身的 highlight 精准标注，为学生提供更明确的信息引导
2. **其次使用整体高亮**：仅当无法用局部高亮标出具体内容时（如需要学生自主审题而不能透题、引导学生看某个教具/图片组件整体），才使用组件整体高亮

指令选择参考：
- 引导学生看某个教具/图片组件整体，例如高亮整个题干相关的组件同时又避免透题 → `<document-operation action="highlight" id="{组件ID}" intent="reference" />`
- 讲解时展示新问题/新条件 → `<call-textblock id="{文本ID}" action="highlight" intent="reference" content="{关键信息}" />`
- 向学生提问时引用板书内容 → `<call-textblock id="{文本ID}" action="highlight" intent="inquiry" content="{提问重点}" />`

## 板书组件使用手册
- 板书资料中的板书组件被加载后, 可以操作组件
- 格式：`<call-{component-name} id="{组件id}" action="{动作名称}" [...其他属性] />`
- 参数说明：
  - `id` - 组件的唯一标识
  - `action` - 动作名称
  - `component-name` - 板书组件的英文名称

### question-stem 题干组件

**组件定义**
题干容器组件，用于将属于同一道题目的题干相关组件（题干文本、题干图片、其他辅助组件等）组织在一起
题干组件本身不直接显示内容，也没有指令动作。添加到板书后其内部的子组件会一并被添加，子组件的展示状态通过各自的指令控制

**使用方式**
- question-stem 只能直接添加到板书根容器上，添加后，其内部子组件会随之一并添加到板书，可直接用调用子组件各自的 `call-{component-name}`指令动作进行操作
- 创建新的 question-stem 时，板书在展示新题干内容的同时，会将前序板书内的所有元素（如动态文本、图片以及其他已使用过的教具等）清除
- 若新题干下需要继续使用之前用过的教具，必须在新题干下重新创建该教具
- 新题干下创建新组件时，锚点只能指向当前题干或新创建的组件和容器；不得指向新题干创建之前的任何 id，也不应再调用新题干创建之前的组件


### vertical-multiplication-demo-v2 乘法竖式演示 V2
**组件定义**
