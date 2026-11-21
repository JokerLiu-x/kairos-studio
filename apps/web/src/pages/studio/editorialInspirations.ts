import glassRain from "./glassRain.webp";
import silkDance from "./silkDance.webp";
import mountainTrain from "./mountainTrain.webp";
import desertRunner from "./desertRunner.webp";
import winterCabin from "./winterCabin.webp";
import poolNight from "./poolNight.webp";
import teaTin from "./teaTin.webp";
import pearl from "./pearl.webp";
import headphones from "./headphones.webp";
import orangeWatch from "./orangeWatch.webp";
import chair from "./chair.webp";
import lipstick from "./lipstick.webp";
import moonRabbit from "./moonRabbit.webp";
import littleSub from "./littleSub.webp";
import paperTown from "./paperTown.webp";
import jelly from "./jelly.webp";
import fox from "./fox.webp";
import island from "./island.webp";
import bluePortrait from "./bluePortrait.webp";
import portraitSun from "./portraitSun.webp";
import metro from "./metro.webp";
import libraryHall from "./libraryHall.webp";
import stoneBath from "./stoneBath.webp";
import bookshop from "./bookshop.webp";

import type { Inspiration } from "./inspirations";

export const editorialInspirations: Inspiration[] = [
  { title: "雨停前一站", category: "电影感", url: glassRain, shape: "tall", prompt: "隔着公交站湿玻璃拍一位撑透明伞的乘客，人物在右侧、站台向左退远。蓝绿霓虹穿过水珠，路面多余招牌化作暗色倒影；焦点落在伞缘和人物轮廓，不让玻璃反光压过主体。", motion: "镜头沿湿玻璃缓慢横移，水滴沿玻璃滑落，乘客保持原位，仅略抬伞沿。蓝绿反光在近景随视角轻移，不切镜。" },
  { title: "绯色一瞬", category: "人物", url: silkDance, shape: "tall", prompt: "黑色剧场，一名现代舞者在单束侧光下转身抬臂，红绸从下缘绕出干净弧线。用全身景别保住指尖和脚尖，背景不加布景，绸布亮缘与皮肤亮度分开。", motion: "固定机位，舞者只做一次舒展转身，红绸惯性向后追随并落下。锁定服装与人物，收尾停在完整轮廓。" },
  { title: "穿雪列车", category: "风景建筑", url: mountainTrain, shape: "wide", prompt: "从山谷上方斜俯拍，一列暗红火车经过白雪覆盖的高架桥。桥梁从左下斜指向右上，列车在中段，远坡渐隐成蓝灰；雪要有地形起伏，红色只来自车身。", motion: "无人机式缓慢前推，红色列车沿原有轨道前行，雪雾偶尔掠过桥脚；山谷不改变，镜头不跨轴。" },
  { title: "粉尘赛道", category: "电影感", url: desertRunner, shape: "wide", prompt: "暮色中的浅粉戈壁上一辆无标识拉力车从左向右掠过，低机位侧拍。车身锐利，尾部拖出分层沙尘，画面上部大面积留给暗粉地平线。" },
  { title: "白桦林的灯", category: "风景建筑", url: winterCabin, shape: "square", prompt: "蓝调雪夜，白桦细枝像竖向笔触，木屋退到林间中景，唯一暖点是窗光。浅蓝雪地保留不均匀脚印与树影，避免让窗户过曝成空白。" },
  { title: "空池夜色", category: "电影感", url: poolNight, shape: "wide", prompt: "从废弃泳池一端看向深处，对称瓷砖和池沿拉出一点透视。紫灯只落在一段斑驳池壁，积水反射钴蓝；四角压暗但保留砖缝，冷清而不做恐怖特效。" },
  { title: "茶山入瓶", category: "产品摄影", url: teaTin, shape: "square", prompt: "无字抹茶罐在低矮苔绿色底座中央，盖口与罐身界线清楚，少量粉末和茶叶卧在右下。大面积柔光拉出哑光漆的细腻明暗，背景从浅玉到深绿自然过渡。" },
  { title: "暗绒珍珠", category: "产品摄影", url: pearl, shape: "tall", prompt: "两枚珍珠耳饰错开放在酒红丝绒的一道折痕上，用微距让珍珠光泽清晰而不爆白。窄光从左后打出单条反射，其他区域压到暗红，丝绒保留细纤维。" },
  { title: "消音室", category: "产品摄影", url: headphones, shape: "square", prompt: "单副奶白头戴耳机搭在炭黑弧形石块上，三分之二侧面视角，看清耳罩内边和头梁弧度。高位柔光只勾轮廓，石材保持无反光，不加品牌和文字。" },
  { title: "钴蓝时间", category: "产品摄影", url: orangeWatch, shape: "wide", prompt: "半透明橙色腕表立在钴蓝树脂方块之间，主件在中部偏左并从背景提亮。背光穿透表带，边缘有细致焦散；高光不过曝，道具不挡表盘。" },
  { title: "日光椅", category: "产品摄影", url: chair, shape: "square", prompt: "用家具目录式三分之二侧角度拍一把悬臂椅，镀铬脚完整落在浅色地面，棕皮坐垫显出张力。侧窗硬光投出长斜影，背景不摆其他家具。" },
  { title: "珊瑚切面", category: "产品摄影", url: lipstick, shape: "wide", prompt: "将红色唇膏竖在一高一低珊瑚粉底座之间，侧拍保留膏体斜切面与圆柱轮廓。高位硬光投下方向一致的阴影，背景与底座同色但明度分层，不加文案。" },
  { title: "月面邮差", category: "动画插画", url: moonRabbit, shape: "square", prompt: "紫丁香色月面上，一只毛线宇航兔站在低矮月岩旁，针织纹路和缝线清楚。用定格动画的近景和低矮地平线，光从左上落下，星空只留几点微亮。", motion: "毛线兔小步跳过一块月岩，背包轻摆，尘粒落回地面。镜头缓慢平移，保持毛线纹理和实体定格质感。" },
  { title: "猫咪潜水艇", category: "动画插画", url: littleSub, shape: "wide", prompt: "一只猫驾驶黄色玩具潜艇穿过圆润的青绿珊瑚，圆窗保持清晰并显出猫脸。前景珊瑚压暗，中景艇身亮黄，气泡向上形成一条清楚的动线。", motion: "潜艇由左向右缓慢滑行，圆窗里的猫转头看一眼珊瑚，少量气泡升起。平滑侧向跟拍，保住艇身轮廓。" },
  { title: "纸上小镇", category: "动画插画", url: paperTown, shape: "square", prompt: "奶油白和桃色纸张折出层叠屋顶与拱门，街道从前景穿到微缩镇中心。用侧光突出纸边和层间暗影，不能有真实砖木纹理，让所有构件都像手工折纸。" },
  { title: "深海漂浮", category: "动画插画", url: jelly, shape: "tall", prompt: "深蓝水层中悬一只半透明青蓝水母，钟形伞盖在上三分之一，细触须向下留足空间。微光来自体内，漂浮颗粒极少，背景不出现礁石或强光斑。", motion: "固定水下视角，水母缓慢收缩一次后上浮，触须滞后摆动；少量颗粒向下漂，不增加其他生物。" },
  { title: "枫林行记", category: "动画插画", url: fox, shape: "wide", prompt: "一只小狐穿过深红枫林，橙色身影尽量留在浅色径轮廓之内。用木刻版画的刻线组织树干、叶簇与尾巴，限制红、橙、墨黑和纸白四种色，保持纸墨颗粒。" },
  { title: "漂浮街区", category: "动画插画", url: island, shape: "square", prompt: "一座黏土微缩岛漂在晴空，小屋分散围住一条弯曲石路，岛底露出手捏层次。相机斜俯拍，清楚分开粉蓝屋顶和奶油墙，保留柔软手工边缘，不做金属反光。" },
  { title: "钴蓝肖像", category: "人物", url: bluePortrait, shape: "tall", prompt: "成人女性湿发贴额，脸朝画外，一束钴蓝侧光只打亮一侧眼窝和湿发轮廓，背景近黑。85mm 肩上近景，准确保留瞳孔、毛孔、细水珠。" },
  { title: "百叶窗下", category: "人物", url: portraitSun, shape: "tall", prompt: "有雀斑的成人面朝窗边，蜂蜜色阳光透过百叶切出几条平行软影。靠近眼睛取景，背景虚化，让肤色在亮暗处自然转换，保留胶片的细颗粒。" },
  { title: "末班站台", category: "风景建筑", url: metro, shape: "wide", prompt: "无人地铁站，中轴对齐扶梯与远处端墙，薄荷绿墙砖和银色扶手递进至消失点。弱冷白灯维持均匀曝光，要求垂直线笔直，不加乘客、车站名或标语。" },
  { title: "书墙回声", category: "风景建筑", url: libraryHall, shape: "square", prompt: "圆形图书馆内景，环形书墙向上拉开，中央楼梯把视线引向天窗。暖米色木材有真实纹理，午光在阶梯形成渐层，构图中轴对称但不消除书架的细小变化。" },
  { title: "苔色汤池", category: "风景建筑", url: stoneBath, shape: "wide", prompt: "粗石围起一方深绿色温泉水池，池面只反射上方森林，保留细小涟漪。相机接近水线，近处石材湿润但无镜面泛光，色彩克制在青绿、炭灰和少量天光。" },
  { title: "雨巷书房", category: "电影感", url: bookshop, shape: "wide", prompt: "站在湿街道对面拍日式书店，橄榄色雨棚下明亮的书架透出暖光。平视中远景，左侧保留暗巷，暖窗倒影延入前景，雨线细而不抢。", motion: "沿街缓慢推近，窗内灯光稳定，雨滴落在雨棚边再坠向前景；保持书店构造与画面内原有道具不变。" },
];
