import * as Cesium from "cesium";
import { ILayerOption } from "../../../layerManager";
import { Cartesian3 } from "../../../map/core/Cartesian3";
// import { Transforms } from "../../../map/core/Transforms";
// import { Transforms } from "../../../map/core/Transforms";
import { InstanceContainer } from "../../../map/instanceContainer";
import { SceneServer } from "../../../map/sceneServer";
import { CustomLabel } from "../../../tools/CustomLabel";
import { Video2Texture } from "../../../tools/Video2Texture";
import { offsetPoint } from "../../../util";
import { IWorkerMsg } from "../../layer";
import { Point } from "../point";
import { DefaultStyle, ILayerStyle } from "./style";

export interface ITextDrawInfo {
    uvs: number[][]; // 四个顶点的uv，从左下角顺时针
    dom: Element; // 当前文本所在的canvas元素
    domId: string; // 当前dom编号
    txtWidth: number; // 当前文本宽度，含内边距
}

export interface IBillDrawInfo {
    index: number[];
    uvs: number[];
    dirs: number[];
    VAO: any;
    commands: any[];
    pickCommand: any[];
    [key: string]: any;
}

export interface IBillMergeDrawInfo {
    [key: string]: any;
}

export interface IBillOriginPos {
    zxj: Cesium.Cartesian3; // 左下角
    zsj: Cesium.Cartesian3; // 左上角
    yxj: Cesium.Cartesian3; // 右下角
    ysj: Cesium.Cartesian3; // 右上角
}

export class CustomTextLabel extends Point<ILayerStyle> {
    public workerFunName!: string;
    public tool!: CustomLabel;
    public mergeDraw!: IBillMergeDrawInfo;
    public singleDraw!: IBillDrawInfo;
    public textureManager: any = {};
    public v2tTool!: Video2Texture;
    private vt: any;
    private fragmentShader!: string;
    private fboVertexShader!: string;
    private mergeVS!: string;
    private bgTexture: any;
    private loadImgSuccess!: boolean;
    // private lastStatus: boolean = true;
    // private showNum: number = 1;
    constructor(viewer: SceneServer, layerName: string, option: ILayerOption<ILayerStyle>) {
        super(viewer, layerName, option);
    }
    public removeData(): void {
        this.singleDraw.commands = [];
        this.singleDraw.pickCommand = [];
        this.singleDraw.VAO = [];
        this.mergeDraw.commands = [];
        this.mergeDraw.VAOManager = {};
        if (this.textureManager) {
            const canvasKeys = Object.keys(this.textureManager);
            canvasKeys.forEach((item) => {
                // document.body.removeChild(this.textureManager[item].dom);
                if (this.textureManager[item].texture && this.textureManager[item].texture.destroy) {
                    this.textureManager[item].texture.destroy();
                }
                delete this.textureManager[item];
            });
        }
        this.tool.reset();
        this.tool.init();
    }
    public updateStyle(style: any): void {
        this.dealCondition(style);
        this.removeData();
        this.postWorkerData();
    }
    public update(frameState: any) {
        if (!this.visible || !this.loadImgSuccess) {
            return;
        }
        const commandList = frameState.commandList;
        if (commandList) {
            if (frameState.passes.render) {
                if (this.baseCfg.mergeDraw) {
                    for (const command of this.mergeDraw.commands) {
                        frameState.commandList.push(command);
                    }
                } else {
                    for (const command of this.singleDraw.commands) {
                        if (command.show) {
                            frameState.commandList.push(command);
                        }
                    }
                }
            } else if (frameState.passes.pick) {
                if (this.baseCfg.mergeDraw) {
                    for (const command of this.singleDraw.pickCommand) {
                        if (command.show) {
                            frameState.commandList.push(command);
                        }
                    }
                } else {
                    for (const command of this.singleDraw.pickCommand) {
                        if (command.show) {
                            frameState.commandList.push(command);
                        }
                    }
                }
            }
        }
        this.vt = this.v2tTool.getTexture(this.viewer);
    }
    public playAnimate() {
        if (this.v2tTool && this.v2tTool.dom) {
            (this.v2tTool.dom as any).play()
        }
    }
    protected onHide(): void {
        this.visible = false;
        // this.lastStatus = false;
    }
    protected onShow(): void {
        this.visible = true;
        // this.lastStatus = true;
    }
    protected onInit(): void {
        this.visible = this.baseCfg.visible;
        this.loadImgSuccess = false;
        this.style = DefaultStyle;
        this.workerFunName = "PointWorkerFun";
        this.collection = new InstanceContainer("command");
        this.appearance = {};
        this.initShader();
        this.singleDraw = {} as any;
        this.singleDraw.commands = [];
        this.singleDraw.pickCommand = [];
        this.mergeDraw = {};
        this.mergeDraw.VAOManager = {};
        this.mergeDraw.commands = [];
        this.bgTexture = {};
        this.viewer.scene.primitives.add(this);
        this.v2tTool = new Video2Texture({
            video: "",
            muted: true,
            autoplay: false,
            loop: false,
        });
    }
    protected async onStyle<ILayerStyle>(style: ILayerStyle) {
        if (!style) {
            style = {} as ILayerStyle;
        }
        this.style = {...this.style, ...style};
        this.appearance.default = {...this.appearance.default, ...this.style};
        this.dealCondition(this.style);
        this.style.layerName = this.layerName;
        // await this.createImageBitmap();
        this.tool = new CustomLabel(this.style);
        this.loadImgSuccess = false;
        await this.prepareBgTexture();
        this.loadImgSuccess = true;
        if (this.style.ableAnimate) {
            this.v2tTool.setVideo(this.style.animateVideo);
            this.viewer.clock.onTick.addEventListener(this.updateVT.bind(this));
        }
    }
    protected async prepareBgTexture() {
        const cons = Object.keys(this.appearance);
        const that = this;
        const proArr = [];
        for (const con of cons) {
            const prom = new Promise((resolve, reject) => {
                const currBgImg = that.appearance[con].imgUrl;
                const img = new Image();
                img.onload = () => {
                    that.bgTexture[con] = new Cesium.Texture({
                        context: (that.viewer.scene as any).context,
                        source: img,
                        pixelFormat: Cesium.PixelFormat.RGBA,
                        pixelDatatype: Cesium.PixelDatatype.FLOAT,
                    });
                    that.appearance[con].naturalWidth = img.width;
                    that.appearance[con].naturalHeight = img.height;
                    that.appearance[con].naturalRatio = img.height / img.width;
                    resolve();
                };
                img.src = currBgImg;
            });
            proArr.push(prom);
        }
        return Promise.all(proArr).then((result) => {
            console.log("所有图片准备就绪")
        }).catch((error) => {
            console.log(error)
        })
    }
    protected onData(option: IWorkerMsg): void {
        const data = (option as any).dataArr;
        if (!data || !data.x) {
            console.warn(`${this.layerName}:worker传递数据有误！`);
            return;
        }
        if (!this.locatedPos) {
            this.locatedPos = Object.assign({}, data) as any;
        }
        const currPoint = option.kdinfo;
        const kdinfo = Object.assign({}, currPoint);
        const currStyle = this.appearance[option.currStyle] || this.appearance.default;
        // const colorStyle = Object.assign({}, currStyle);
        const textInfo = this.tool.drawText(kdinfo[this.style.fieldKey || "name"], currStyle);
        if (!textInfo) {
            return;
        }
        // textInfo.txtWidth = textInfo.txtWidth / 2;
        this.prepareText(option, textInfo);
        // let currMat = Transforms.eastNorthUpToFixedFrame(origin as any);
    }
    protected onDestroy(): void {
        this.viewer.scene.primitives.remove(this);
        this.destroyTexture();
        this.viewer.clock.onTick.removeEventListener(this.updateVT.bind(this));
    }
    protected onDataOver(): void {
        const that = this;
        if (this.baseCfg.mergeDraw) {
            this.prepareMergeVAO();
        }
        that.createTexture();
        that.prepareCommand();
        that.prepareMergeCommand();
        this.collection.commands = this.singleDraw.commands;
        // setTimeout(() => {
        //     that.createTexture();
        //     that.prepareCommand();
        //     that.prepareMergeCommand();
        // }, 10000);
        if (this.baseCfg.visible) {
            if (this.judgeCurrLevlShow()) {
                this.onShow();
            } else {
                this.onHide();
            }
        } else {
            this.onHide();
        }
        setTimeout(() => {
            this.playAnimate();
        }, 500);
    }
    private updateVT() {
        if (!this.v2tTool || !this.v2tTool.dom) {
            return;
        }
        this.vt = this.v2tTool.getTexture(this.viewer);
    }
    private prepareText(option: IWorkerMsg, info: ITextDrawInfo) {
        if (this.baseCfg.mergeDraw) {
            this.prepareSingle(option, info);
            this.prepareMerge(option, info);
        } else {
            this.prepareSingle(option, info);
        }
    }
    private prepareMerge(option: IWorkerMsg, info: ITextDrawInfo) {
        this.prepareTexture(info);
        if (!this.textureManager[info.domId]) {
            return;
        }
        let point = option.dataArr as any;
        const baseCfg = this.baseCfg;
        // tslint:disable-next-line: max-line-length
        point = offsetPoint(point as any, (baseCfg as any).northOffset, (baseCfg as any).eastOffset, (this.style as any).heightOffset || 0.0) as any;
        if (!this.mergeDraw.VAOManager[info.domId]) {
            this.mergeDraw.VAOManager[info.domId] = {
                vertexs_H: [],
                vertexs_L: [],
                color: [],
                uv: [],
                indexs: [],
                VAO: {},
                option,
            };
        }
        // tslint:disable-next-line: variable-name
        const vertexs_H = this.mergeDraw.VAOManager[info.domId].vertexs_H;
        // tslint:disable-next-line: variable-name
        const vertexs_L = this.mergeDraw.VAOManager[info.domId].vertexs_L;
        const indexs = this.mergeDraw.VAOManager[info.domId].indexs;
        const uvs = this.mergeDraw.VAOManager[info.domId].uv;
        const colors = this.mergeDraw.VAOManager[info.domId].color;
        const lastNum = indexs[indexs.length - 1] || 0;
        if (!lastNum) {
            indexs.push(0);
            indexs.push(2);
            indexs.push(1);
            indexs.push(0);
            indexs.push(3);
            indexs.push(2);
        } else {
            indexs.push(lastNum + 1 + 1 + 0);
            indexs.push(lastNum + 1 + 1 + 2);
            indexs.push(lastNum + 1 + 1 + 1);
            indexs.push(lastNum + 1 + 1 + 0);
            indexs.push(lastNum + 1 + 1 + 3);
            indexs.push(lastNum + 1 + 1 + 2);
        }
        const currDF = computedDoubleFloat(point);
        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        uvs.push(info.uvs[0][0], info.uvs[0][1], 0, 0);
        uvs.push(info.uvs[1][0], info.uvs[1][1], 0, 1);
        uvs.push(info.uvs[2][0], info.uvs[2][1], 1, 1);
        uvs.push(info.uvs[3][0], info.uvs[3][1], 1, 0);
        // const trans = Cesium.Transforms.eastNorthUpToFixedFrame(point as any);
        // const trans = Cesium.Matrix4.IDENTITY;
        // let currMat = trans;
        // tslint:disable-next-line: max-line-length
        // const ratio = this.appearance[option.currStyle].fixedHeight / this.appearance[option.currStyle].fixedWidth;
        const currOrigin = this.computedOrigin(this.appearance[option.currStyle]);
        const zxj = currOrigin.zxj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, zxj, zxj);
        // Cesium.Cartesian3.normalize(zxj, zxj);
        colors.push(zxj.x, zxj.y, zxj.z, info.txtWidth);

        const zsj = currOrigin.zsj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, zsj, zsj);
        // Cesium.Cartesian3.normalize(zsj, zsj);
        colors.push(zsj.x, zsj.y, zsj.z, info.txtWidth);

        const ysj = currOrigin.ysj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, ysj, ysj);
        // Cesium.Cartesian3.normalize(ysj, ysj);
        colors.push(ysj.x, ysj.y, ysj.z, info.txtWidth);

        const yxj = currOrigin.yxj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, yxj, yxj);
        // Cesium.Cartesian3.normalize(yxj, yxj);
        colors.push(yxj.x, yxj.y, yxj.z, info.txtWidth);
    }
    private prepareMergeVAO() {
        const domids = Object.keys(this.mergeDraw.VAOManager);
        for (const domId of domids) {
            const curr = this.mergeDraw.VAOManager[domId];
            this.mergeDraw.VAOManager[domId].VAO = {
                index: new Uint16Array(curr.indexs),
                vertex_H: {
                    values: new Float32Array(curr.vertexs_H),
                    componentDatatype: "DOUBLE",
                    componentsPerAttribute: 3,
                },
                vertex_L: {
                    values: new Float32Array(curr.vertexs_L),
                    componentDatatype: "DOUBLE",
                    componentsPerAttribute: 3,
                },
                uv: {
                    values: new Float32Array(curr.uv),
                    componentDatatype: "FLOAT",
                    componentsPerAttribute: 4,
                },
                color: {
                    values: new Float32Array(curr.color),
                    componentDatatype: "FLOAT",
                    componentsPerAttribute: 4,
                },
                texture: domId,
            };
        }
    }
    private prepareSingle(option: IWorkerMsg, info: ITextDrawInfo) {
        this.prepareTexture(info);
        if (!this.textureManager[info.domId]) {
            return;
        }
        let point = option.dataArr as any;
        const baseCfg = this.baseCfg;
        // tslint:disable-next-line: max-line-length
        point = offsetPoint(point as any, (baseCfg as any).northOffset, (baseCfg as any).eastOffset, (this.style as any).heightOffset || 0.0) as any;
        // tslint:disable-next-line: variable-name
        const vertexs_H = [];
        // tslint:disable-next-line: variable-name
        const vertexs_L = [];
        const indexs = [];
        const uvs = [];
        const colors = [];
        indexs.push(0);
        indexs.push(2);
        indexs.push(1);
        indexs.push(0);
        indexs.push(3);
        indexs.push(2);
        const currDF = computedDoubleFloat(point);
        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        vertexs_H.push(currDF[0]);
        vertexs_H.push(currDF[2]);
        vertexs_H.push(currDF[4]);
        vertexs_L.push(currDF[1]);
        vertexs_L.push(currDF[3]);
        vertexs_L.push(currDF[5]);

        uvs.push(info.uvs[0][0], info.uvs[0][1], 0, 0);
        uvs.push(info.uvs[1][0], info.uvs[1][1], 0, 1);
        uvs.push(info.uvs[2][0], info.uvs[2][1], 1, 1);
        uvs.push(info.uvs[3][0], info.uvs[3][1], 1, 0);
        // const trans = Cesium.Transforms.eastNorthUpToFixedFrame(point as any);
        // const trans = Cesium.Matrix4.IDENTITY;
        // let currMat = trans;
        // tslint:disable-next-line: max-line-length
        // const ratio = this.appearance[option.currStyle].fixedHeight / this.appearance[option.currStyle].fixedWidth;
        const currOrigin = this.computedOrigin(this.appearance[option.currStyle]);
        const zxj = currOrigin.zxj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, zxj, zxj);
        // Cesium.Cartesian3.normalize(zxj, zxj);
        colors.push(zxj.x, zxj.y, zxj.z);

        const zsj = currOrigin.zsj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, zsj, zsj);
        // Cesium.Cartesian3.normalize(zsj, zsj);
        colors.push(zsj.x, zsj.y, zsj.z);

        const ysj = currOrigin.ysj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, ysj, ysj);
        // Cesium.Cartesian3.normalize(ysj, ysj);
        colors.push(ysj.x, ysj.y, ysj.z);

        const yxj = currOrigin.yxj;
        // Cesium.Matrix4.multiplyByPointAsVector(trans, yxj, yxj);
        // Cesium.Cartesian3.normalize(yxj, yxj);
        colors.push(yxj.x, yxj.y, yxj.z);

        const VAO = {
            index: new Uint16Array(indexs),
            vertex_H: {
                values: new Float32Array(vertexs_H),
                componentDatatype: "DOUBLE",
                componentsPerAttribute: 3,
            },
            vertex_L: {
                values: new Float32Array(vertexs_L),
                componentDatatype: "DOUBLE",
                componentsPerAttribute: 3,
            },
            uv: {
                values: new Float32Array(uvs),
                componentDatatype: "FLOAT",
                componentsPerAttribute: 4,
            },
            color: {
                values: new Float32Array(colors),
                componentDatatype: "FLOAT",
                componentsPerAttribute: 3,
            },
            texture: info.domId,
            txtWidth: info.txtWidth,
            id: option.kdinfo.id,
            kdinfo: option.kdinfo,
            option,
        };

        if (!this.singleDraw.VAO) {
            this.singleDraw.VAO = [];
        }
        this.singleDraw.VAO.push(VAO);
    }
    private prepareTexture(info: ITextDrawInfo) {
        if (!info.dom || this.textureManager[info.domId]) {
            return;
        }
        this.textureManager[info.domId] = {};
        this.textureManager[info.domId].dom = info.dom;
        // new Cesium.Texture({
        //     context: (this.viewer.scene as any).context,
        //     source: info.dom || (this.viewer.scene as any).context.defaultTexture,
        //     pixelFormat: "RGBA",
        //     pixelDatatype: "FLOAT",
        // });
    }
    private prepareMergeCommand() {
        if (!this.baseCfg.mergeDraw) {
            return;
        }
        const context = (this.viewer.scene as any).context;
        const vs = this.mergeVS;
        const fs = this.fragmentShader;
        const width = context.drawingBufferWidth;
        const height = context.drawingBufferHeight;
        const mergeKey = Object.keys(this.mergeDraw.VAOManager);
        const sp = (Cesium as any).ShaderProgram.fromCache({
            context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations: {
                position3DHigh: 0,
                position3DLow: 1,
                color: 2,
                st: 3,
            },
        });
        for (const domId of mergeKey) {
            const currVao = this.mergeDraw.VAOManager[domId];
            const VAO = currVao.VAO;
            const indexBuffer = (Cesium as any).Buffer.createIndexBuffer({
                context,
                typedArray : VAO.index,
                usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                indexDatatype : Cesium.IndexDatatype.UNSIGNED_SHORT,
            });

            const va = new (Cesium as any).VertexArray({
                context,
                attributes : [
                    {
                        index : 0,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.vertex_H.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 3,
                    },
                    {
                        index : 1,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.vertex_L.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 3,
                    },
                    {
                        index : 2,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.color.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 4,
                    },
                    {
                        index : 3,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.uv.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 4,
                    },
                ],
                indexBuffer,
            });

            const rs = Cesium.RenderState.fromCache();
            const that = this;
            const bs = Cesium.BoundingSphere.fromVertices(VAO.vertex_H.values);
            const command = new (Cesium as any).DrawCommand({
                primitiveType : Cesium.PrimitiveType.TRIANGLES,
                shaderProgram : sp,
                vertexArray : va,
                modelMatrix : Cesium.Matrix4.IDENTITY,
                pickOnly: true,
                renderState: rs,
                boundingVolume: bs,
                uniformMap: {
                    mm() {
                        return (that.viewer.scene.camera.frustum as any)._offCenterFrustum._perspectiveMatrix;
                    },
                    vv() {
                        // return that.viewer.scene.camera._viewMatrix;
                        return that.viewer.scene.camera.viewMatrix;
                    },
                    resolution() {
                        return new Cesium.Cartesian2(width, height);
                    },
                    billWidth() {
                        return that.appearance[currVao.option.currStyle || "default"].fixedWidth;
                    },
                    scaleByDistance() {
                        const style = that.appearance[currVao.option.currStyle || "default"];
                        return new Cesium.Cartesian4(style.near, style.scale, style.far, style.ratio);
                    },
                    cameraPosition() {
                        return that.viewer.camera.position;
                    },
                    billImg() {
                        // tslint:disable-next-line: max-line-length
                        return that.textureManager && that.textureManager[VAO.texture] && that.textureManager[VAO.texture].texture || context.defaultTexture;
                    },
                    distanceDisplay() {
                        const style = that.appearance[currVao.option.currStyle || "default"];
                        return style.distanceDisplay;
                    },
                    bgTexture() {
                        return that.bgTexture[currVao.option.currStyle || "default"] || context.defaultTexture;
                    },
                    offsetXY() {
                        const style = that.appearance[currVao.option.currStyle || "default"];
                        return new Cesium.Cartesian2(style.offsetX || 0, -style.offsetY || 0);
                    },
                    u_devicePixelRatio() {
                        return that.viewer.resolutionScale || 1.0;
                    },
                    animateTex() {
                        return that.vt || (that.viewer.scene as any).context.defaultTexture;
                    },
                    ableAnimate() {
                        return that.style.ableAnimate;
                    }
                },
                castShadows: false,
                receiveShadows: false,
                pass : (Cesium as any).Pass.TRANSLUCENT,
            });
            this.mergeDraw.commands.push(command);
        }
    }
    private prepareCommand() {
        // if (this.baseCfg.mergeDraw) {
        //     return;
        // }
        if (!this.singleDraw.VAO || !this.singleDraw.VAO.length) {
            console.log(`${this.layerName}:没有数据`);
            return;
        }
        const context = (this.viewer.scene as any).context;
        const vs = this.fboVertexShader;
        const fs = this.fragmentShader;
        const width = context.drawingBufferWidth;
        const height = context.drawingBufferHeight;
        const sp = (Cesium as any).ShaderProgram.fromCache({
            context,
            vertexShaderSource : vs,
            fragmentShaderSource : fs,
            attributeLocations: {
                position3DHigh: 0,
                position3DLow: 1,
                color: 2,
                st: 3,
            },
        });
        for (const VAO of this.singleDraw.VAO) {
            const indexBuffer = (Cesium as any).Buffer.createIndexBuffer({
                context,
                typedArray : VAO.index,
                usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                indexDatatype : Cesium.IndexDatatype.UNSIGNED_SHORT,
            });

            const va = new (Cesium as any).VertexArray({
                context,
                attributes : [
                    {
                        index : 0,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.vertex_H.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 3,
                    },
                    {
                        index : 1,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.vertex_L.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 3,
                    },
                    {
                        index : 2,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.color.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 3,
                    },
                    {
                        index : 3,
                        vertexBuffer : (Cesium as any).Buffer.createVertexBuffer({
                            context,
                            typedArray : VAO.uv.values,
                            usage : (Cesium as any).BufferUsage.STATIC_DRAW,
                        }),
                        componentsPerAttribute : 4,
                    },
                ],
                indexBuffer,
            });

            const rs = Cesium.RenderState.fromCache();
            const that = this;
            const bs = Cesium.BoundingSphere.fromVertices(VAO.vertex_H.values);
            const command = new (Cesium as any).DrawCommand({
                primitiveType : Cesium.PrimitiveType.TRIANGLES,
                shaderProgram : sp,
                vertexArray : va,
                modelMatrix : Cesium.Matrix4.IDENTITY,
                pickOnly: true,
                renderState: rs,
                boundingVolume: bs,
                uniformMap: {
                    mm() {
                        return (that.viewer.scene.camera.frustum as any)._offCenterFrustum._perspectiveMatrix;
                    },
                    vv() {
                        // return that.viewer.scene.camera._viewMatrix;
                        return that.viewer.scene.camera.viewMatrix;
                    },
                    resolution() {
                        return new Cesium.Cartesian2(width, height);
                    },
                    billWidth() {
                        return that.appearance[VAO.option.currStyle || "default"].fixedWidth;
                    },
                    scaleByDistance() {
                        const style = that.appearance[VAO.option.currStyle || "default"];
                        return new Cesium.Cartesian4(style.near, style.scale, style.far, style.ratio);
                    },
                    cameraPosition() {
                        return that.viewer.camera.position;
                    },
                    billImg() {
                        // tslint:disable-next-line: max-line-length
                        return that.textureManager && that.textureManager[VAO.texture] && that.textureManager[VAO.texture].texture || context.defaultTexture;
                    },
                    distanceDisplay() {
                        const style = that.appearance[VAO.option.currStyle || "default"];
                        return style.distanceDisplay;
                    },
                    bgTexture() {
                        return that.bgTexture[VAO.option.currStyle || "default"] || context.defaultTexture;
                    },
                    offsetXY() {
                        const style = that.appearance[VAO.option.currStyle || "default"];
                        return new Cesium.Cartesian2(style.offsetX || 0, -style.offsetY || 0);
                    },
                    u_devicePixelRatio() {
                        return that.viewer.resolutionScale || 1.0;
                    },
                    animateTex() {
                        return that.vt || (that.viewer.scene as any).context.defaultTexture;
                    },
                    ableAnimate() {
                        return that.style.ableAnimate;
                    }
                },
                castShadows: false,
                receiveShadows: false,
                pass : (Cesium as any).Pass.TRANSLUCENT,
            });
            command.id = VAO.id;
            command.kd_info = VAO.kdinfo;
            command.kd_style = this.style;
            command.show = true;
            this.singleDraw.commands.push(command);

            const pickCommand = new (Cesium as any).DrawCommand({
                owner : command,
                primitiveType: Cesium.PrimitiveType.TRIANGLES,
                pickOnly : true,
            });
            pickCommand.show = true;
            pickCommand.vertexArray = va;
            pickCommand.renderState = rs;
            const sp1 = (Cesium as any).ShaderProgram.fromCache({
                context,
                vertexShaderSource : vs,
                fragmentShaderSource : (Cesium as any).ShaderSource.createPickFragmentShaderSource(fs, "uniform"),
                attributeLocations: {
                    position3DHigh: 0,
                    position3DLow: 1,
                    color: 2,
                    st: 3,
                },
            });
            command.pickId = context.createPickId({
                primitive : command,
                id : VAO.domId,
            });
            pickCommand.shaderProgram = sp1;
            pickCommand.uniformMap = command.uniformMap;
            pickCommand.uniformMap.czm_pickColor = () => {
                return command.pickId.color;
            };
            pickCommand.pass = (Cesium as any).Pass.TRANSLUCENT;
            pickCommand.boundingVolume = bs;
            pickCommand.modelMatrix = Cesium.Matrix4.IDENTITY;
            this.singleDraw.pickCommand.push(pickCommand);
        }
    }
    private initShader() {
        this.fragmentShader = `
        #ifdef GL_ES
        precision mediump float;
        #endif
        uniform sampler2D billImg;
        uniform sampler2D bgTexture;
        uniform sampler2D animateTex;
        uniform bool ableAnimate;
        varying vec4 v_st;
        void main() {
            vec4 bgcolor = texture2D(bgTexture,v_st.zw);
            vec4 txtColor = texture2D(billImg,v_st.xy);
            gl_FragColor = mix(bgcolor, txtColor, txtColor.a * 1.5);
            if (ableAnimate) {
                vec4 aniC = texture2D(animateTex,v_st.zw);
                float cnum = distance(aniC.rgb, vec3(.0));
                cnum = step(0.01, cnum);
                gl_FragColor *= cnum;
            }
        }
        `;

        this.fboVertexShader = `
        attribute vec3 position3DHigh;
        attribute vec3 position3DLow;
        attribute vec3 color;
        attribute vec4 st;
        attribute float batchId;
        uniform mat4 mm;
        uniform mat4 vv;
        uniform vec2 resolution;
        uniform vec2 offsetXY;
        uniform float billWidth;
        uniform vec4 scaleByDistance;
        uniform vec3 cameraPosition;
        uniform bool distanceDisplay;
        // uniform float u_devicePixelRatio;
        varying vec4 v_st;
        vec4 transform(mat4 m,mat4 v,vec3 coord) {
            return m * v * vec4(coord, 1.0);
        }
        vec2 project(vec4 device) {
            vec3 device_normal = device.xyz / device.w;
            vec2 clip_pos = (device_normal * 0.5 + 0.5).xy;
            return clip_pos * resolution;
        }
        vec4 unproject(vec2 screen, float z, float w) {
            vec2 clip_pos = screen / resolution;
            vec2 device_normal = clip_pos * 2.0 - 1.0;
            return vec4(device_normal * w, z, w);
        }
        void main() {
            v_st = st;
            vec3 currP = position3DHigh.xyz + position3DLow.xyz;
            float dis = distance(currP, cameraPosition);
            if (distanceDisplay) {
                if (dis<scaleByDistance.x || dis > scaleByDistance.z) {
                    return;
                }
            }
            float currScale = scaleByDistance.y + (scaleByDistance.w - scaleByDistance.y) * (dis - scaleByDistance.x) / (scaleByDistance.z - scaleByDistance.x);
            currScale = clamp(currScale, scaleByDistance.w, scaleByDistance.y);
            vec4 eyeCurrP = transform(mm,vv,currP);
            vec2 winCurrP = project(eyeCurrP);
            vec3 dirEye = color;
            vec2 newWinCurrP = winCurrP + dirEye.xy * billWidth * currScale;
            newWinCurrP = offsetXY + newWinCurrP;
            gl_Position = unproject(newWinCurrP, eyeCurrP.z, eyeCurrP.w);
            gl_PointSize = billWidth;
        }
        `;

        this.mergeVS = `
        attribute vec3 position3DHigh;
        attribute vec3 position3DLow;
        attribute vec4 color;
        attribute vec4 st;
        attribute float batchId;
        uniform mat4 mm;
        uniform mat4 vv;
        uniform vec2 resolution;
        uniform vec2 offsetXY;
        uniform vec4 scaleByDistance;
        uniform vec3 cameraPosition;
        uniform bool distanceDisplay;
        // uniform float u_devicePixelRatio;
        varying vec4 v_st;
        vec4 transform(mat4 m,mat4 v,vec3 coord) {
            return m * v * vec4(coord, 1.0);
        }
        vec2 project(vec4 device) {
            vec3 device_normal = device.xyz / device.w;
            vec2 clip_pos = (device_normal * 0.5 + 0.5).xy;
            return clip_pos * resolution;
        }
        vec4 unproject(vec2 screen, float z, float w) {
            vec2 clip_pos = screen / resolution;
            vec2 device_normal = clip_pos * 2.0 - 1.0;
            return vec4(device_normal * w, z, w);
        }
        void main() {
            v_st = st;
            vec3 currP = position3DHigh.xyz + position3DLow.xyz;
            float dis = distance(currP, cameraPosition);
            if (distanceDisplay) {
                if (dis<scaleByDistance.x || dis > scaleByDistance.z) {
                    return;
                }
            }
            float currScale = scaleByDistance.y + (scaleByDistance.w - scaleByDistance.y) * (dis - scaleByDistance.x) / (scaleByDistance.z - scaleByDistance.x);
            currScale = clamp(currScale, scaleByDistance.w, scaleByDistance.y);
            vec4 eyeCurrP = transform(mm,vv,currP);
            vec2 winCurrP = project(eyeCurrP);
            vec3 dirEye = color.xyz;
            vec2 newWinCurrP = winCurrP + dirEye.xy * color.w * currScale;
            newWinCurrP = offsetXY + newWinCurrP;
            gl_Position = unproject(newWinCurrP, eyeCurrP.z, eyeCurrP.w);
        }
        `;
    }
    private createTexture() {
        Object.keys(this.textureManager).forEach((domId) => {
            this.textureManager[domId].texture = new Cesium.Texture({
                context: (this.viewer.scene as any).context,
                source: this.textureManager[domId].dom || (this.viewer.scene as any).context.defaultTexture,
                pixelFormat: Cesium.PixelFormat.RGBA,
                pixelDatatype: Cesium.PixelDatatype.FLOAT,
            });
        });
    }
    // private createImageBitmap() {
    //     return new Promise((resolve, reject) => {
    //         const image = new Image();
    //         image.onload = () => {
    //             resolve(Promise.all([
    //                 createImageBitmap(image, 0, 0, image.width, image.height),
    //             ]).then((sprites) => {
    //                 this.style.bgImg = sprites[0];
    //                 this.dealCondition(this.style);
    //             }));
    //         };
    //         image.src = this.style.imgUrl;
    //     });
    // }
    private destroyTexture() {
        Object.keys(this.textureManager).forEach((domId) => {
            if (this.textureManager[domId]) {
                if (this.textureManager[domId].texture) {
                    this.textureManager[domId].texture.destroy();
                }
            }
        });
    }
    private computedOrigin(style: ILayerStyle): IBillOriginPos {
        if (!style) {
            style = style || this.style;
        }
        const ratio = style.fixedHeight / style.fixedWidth;
        const origin: IBillOriginPos = {
            zxj: new Cesium.Cartesian3(),
            zsj: new Cesium.Cartesian3(),
            yxj: new Cesium.Cartesian3(),
            ysj: new Cesium.Cartesian3(),
        }
        if (style.horizontalOrigin === "CENTER") {
            if (style.verticalOrigin === "TOP") {
                origin.zsj.x = -0.5;
                origin.zsj.y = 0;
                origin.zxj.x = -0.5;
                origin.zxj.y = -ratio;

                origin.ysj.x = 0.5;
                origin.ysj.y = 0;
                origin.yxj.x = 0.5;
                origin.yxj.y = -ratio;
            }

            if (style.verticalOrigin === "CENTER") {
                origin.zsj.x = -0.5;
                origin.zsj.y = ratio / 2;
                origin.zxj.x = -0.5;
                origin.zxj.y = -ratio / 2;

                origin.ysj.x = 0.5;
                origin.ysj.y = ratio / 2;
                origin.yxj.x = 0.5;
                origin.yxj.y = -ratio / 2;
            }

            if (style.verticalOrigin === "BOTTOM") {
                origin.zsj.x = -0.5;
                origin.zsj.y = ratio;
                origin.zxj.x = -0.5;
                origin.zxj.y = 0;

                origin.ysj.x = 0.5;
                origin.ysj.y = ratio;
                origin.yxj.x = 0.5;
                origin.yxj.y = 0;
            }
        }
        return origin;
    }
}

// 伪造双精度数据
const computedDoubleFloat = (car: Cartesian3) => {
    const fa = new Float32Array(6);
    fa[0] = car.x;
    fa[1] = car.x - fa[0];
    fa[2] = car.y;
    fa[3] = car.y - fa[2];
    fa[4] = car.z;
    fa[5] = car.z - fa[4];
    return fa;
};
