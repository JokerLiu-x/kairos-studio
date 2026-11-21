import clouds from "./clouds.webp";
import courtyard from "./courtyard.webp";
import perfume from "./perfume.webp";
import coast from "./coast.webp";
import neon from "./neon.webp";
import serum from "./serum.webp";
import forest from "./forest.webp";
import museum from "./museum.webp";
import portrait from "./portrait.webp";
import orbit from "./orbit.webp";
import bakery from "./bakery.webp";
import sneaker from "./sneaker.webp";
import records from "./records.webp";
import waves from "./waves.webp";
import soda from "./soda.webp";
import explorer from "./explorer.webp";
import { editorialInspirations } from "./editorialInspirations";

export const categories = ["全部", "电影感", "产品摄影", "动画插画", "人物", "风景建筑"] as const;
export type InspirationCategory = (typeof categories)[number];
export type Inspiration = {
  title: string;
  category: Exclude<InspirationCategory, "全部">;
  url: string;
  position?: string;
  shape: "wide" | "square" | "tall";
  prompt: string;
  motion?: string;
};

export const inspirations: Inspiration[] = [
  { title: "霓虹之后", category: "电影感", url: neon, shape: "wide", prompt: "雨夜，侦探从骑楼深处走到画面中央，半身正视。用 35mm 平视中景，左右店铺压出纵深；左侧蓝灯扫亮湿外套，右侧红灯在积水拉出长反光。背景招牌虚化到不可辨读，面部暗部保留纹理。", motion: "单镜头缓慢后移，侦探向前走两步，保持半身构图；雨落在肩线，积水里的红蓝反光随脚步轻微破碎。不要切镜，不改变人物外貌。" },
  { title: "蓝色冷萃", category: "产品摄影", url: serum, shape: "square", prompt: "钴蓝玻璃滴管瓶直立于波浪形银座中央，低机位近景，瓶身占画面高度约三分之二。背光打透蓝玻璃，侧边留一条窄亮线；水弧绕过瓶体两侧，不遮挡瓶口，水珠边缘清晰，背景为冷银灰。" },
  { title: "春日侧写", category: "人物", url: portrait, shape: "tall", prompt: "短发女模特穿深红翻领外套，肩部斜向镜头，眼睛看画外上方。85mm 肩上近景，头顶留少量呼吸空间；暖灰混凝土保持克制，一侧漫射光扫出颧骨与衣领织纹，保留真实皮肤，不做塑料磨皮。" },
  { title: "苔森林来信", category: "动画插画", url: forest, shape: "wide", prompt: "把红围巾邮差放在林间小径的明暗交界处，双手握住信件。近处苔藓铺成暗绿，中景枝叶留一扇暖黄光窗，远处林枝水彩湿边。人物线条比环境更明确，保留纸面与颜料颗粒。" },
  { title: "轨道之外", category: "电影感", url: orbit, shape: "tall", prompt: "站在碎石坡上的宇航员缩成画幅下方的小剪影，一颗蓝色行星从他身后升起，弧面占上半幅。远处岩脊层层递进，保留夜空的暗部和稀少星点，只有行星边缘一线冷光。", motion: "镜头从背后缓慢推近，宇航员保持站姿，低空云沿山脊左移；行星只做极轻微视差，保住大小关系，避免快速旋转与镜头抖动。" },
  { title: "庭院晴光", category: "人物", url: courtyard, position: "72% 50%", shape: "wide", prompt: "廊下女子侧身抬眼，站在画面右三分之一处。左上花枝在近景虚化，廊柱逐级后退；暖光只落到侧脸和浅色衣料，背后的木构保留深色层次。不要正对镜头或摆拍式微笑。" },
  { title: "天窗之下", category: "风景建筑", url: museum, shape: "square", prompt: "日照下的洞石美术馆，椭圆天窗占上半幅，水平水面占下三分之一。相机正对入口，垂直线保持笔直；日光穿孔投出硬边几何影，水面完整反射建筑，洞石孔隙真实可见。" },
  { title: "凌晨唱片店", category: "电影感", url: records, shape: "wide", prompt: "从唱片店入口平视，中央铬合金试听台成为前景锚点，两排唱片指向尽头落地窗。用蓝调天光加淡紫色室内线灯，玻璃只留柔和倒影；让角落维持暗调，不把整家店打成霓虹招牌。" },
  { title: "火山跑道", category: "产品摄影", url: sneaker, shape: "wide", prompt: "单只青柠色越野鞋横向悬停，鞋头朝左，侧前方 30° 看见鞋面织纹和大底凸齿。炭灰碎石留在底部，细小砂粒向后定格飞散；硬侧光勾鞋边，背景压暗，不出现商标。" },
  { title: "企鹅面包房", category: "动画插画", url: bakery, shape: "square", prompt: "在微缩烘焙店里安排三只羊毛毡企鹅：一只在台前递面包、两只在铜炉旁忙碌。低到柜台边的定格动画视角，保留毡纤维、烤盘划痕和斜窗光，暖橙炉口与清冷窗光分层。", motion: "保持三只企鹅的位置和大小，前景那只把面包推向柜台边，铜炉口亮度轻微跳动。小幅推进，模仿逐帧定格节奏，避免角色变形。" },
  { title: "云海山峦", category: "风景建筑", url: clouds, position: "42% 50%", shape: "wide", prompt: "把崖边松树放在左下，远峰沿对角线退入云海。太阳靠近地平线，边缘薄雾泛暖金，背光山体保持冷灰，分开至少四层山脊；不要把阴影抬亮成平面，不加重口味光晕。" },
  { title: "蓝浪与帆", category: "动画插画", url: waves, shape: "tall", prompt: "双色套印版画：左侧钴蓝巨浪呈弧形向上卷，白帆小舟留在右侧低处，右上以一枚柿红圆日压住空间。用刀刻般的白线处理浪花，保留纸纹与偏淡的套印，不用拟真水面或渐变。" },
  { title: "气泡柑橘", category: "产品摄影", url: soda, shape: "square", prompt: "珊瑚粉背景和台面连成一体，正中放一只压纹杯，杯中血橙切片、透明冰块和细密气泡。右上方硬光投出清楚长影，两瓣柑橘作低矮陪衬，杯口与冰块不能过曝。" },
  { title: "沙丘探险队", category: "动画插画", url: explorer, shape: "square", prompt: "戴琥珀护目镜的小探险家在左前方蹲下，伴随一台白色小机器人看向同一处。低机位，远处的沙色拱墙沿对角线退远；用赭黄尘土、蓝天和白色金属建立三色关系，服装褶皱有风吹方向。" },
  { title: "梨与香氛", category: "产品摄影", url: perfume, shape: "wide", prompt: "浅石台上放透明方瓶和一只切开的梨，银亮瓶盖比绿梨高半头。侧逆光穿过瓶内液体，在石面投下窄亮斑；用浅景深让后墙树影柔化，瓶口和梨切面保持清晰，不出现包装文字。" },
  { title: "海岸之境", category: "风景建筑", url: coast, shape: "wide", prompt: "从临海崖顶侧向远眺，崖壁从右前向水平线退去，左侧留出深钴蓝大海。清午光切出断崖纹理，白浪只沿礁石形成细线；保持水平线平直，避免青橙滤镜和人为梦幻雾。" },
];

inspirations.splice(1, 0, ...editorialInspirations.slice(0, 3));
inspirations.splice(6, 0, ...editorialInspirations.slice(6, 8), ...editorialInspirations.slice(12, 14), ...editorialInspirations.slice(18, 20));
inspirations.push(...editorialInspirations.slice(3, 6), ...editorialInspirations.slice(8, 12), ...editorialInspirations.slice(14, 18), ...editorialInspirations.slice(20));
