/**\n\
 *\n\
 * @name czm_spotLightInput\n\
 * @glslStruct\n\
 *\n\
 * @property {vec3} color 光颜色.\n\
 * @property {vec3} position 光位置 视角空间下.\n\
 * @property {float} intensity 光强度.\n\
 * @property {float} dis 光有效距离.\n\
 * @property {bool} enable 是否激活.\n\
 * @property {float} angle 夹角 cos值.\n\
 * @property {vec3} direction 方向， 视角空间下.\n\
 */
struct czm_spotLightInput
{
    vec3 position;
    vec3 color;
    float intensity;
    float dis;
    bool enable;
    vec3 direction;
    float angle;
};