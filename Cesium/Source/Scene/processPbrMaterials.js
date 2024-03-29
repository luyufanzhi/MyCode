import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import webGLConstantToGlslType from "../Core/webGLConstantToGlslType.js";
import addToArray from "../ThirdParty/GltfPipeline/addToArray.js";
import ForEach from "../ThirdParty/GltfPipeline/ForEach.js";
import hasExtension from "../ThirdParty/GltfPipeline/hasExtension.js";
import ModelUtility from "./ModelUtility.js";
import ExpandBySTC from '../Kedacom/ExpandBySTC.js';
import Color from "../Core/Color.js";

/**
 * @private
 */
function processPbrMaterials(gltf, options) {
  options = defaultValue(options, defaultValue.EMPTY_OBJECT);

  // No need to create new techniques if they already exist,
  // the shader should handle these values
  if (hasExtension(gltf, "KHR_techniques_webgl")) {
    return gltf;
  }

  // All materials in glTF are PBR by default,
  // so we should apply PBR unless no materials are found.
  if (!defined(gltf.materials) || gltf.materials.length === 0) {
    return gltf;
  }

  if (!defined(gltf.extensions)) {
    gltf.extensions = {};
  }

  if (!defined(gltf.extensionsUsed)) {
    gltf.extensionsUsed = [];
  }

  if (!defined(gltf.extensionsRequired)) {
    gltf.extensionsRequired = [];
  }

  gltf.extensions.KHR_techniques_webgl = {
    programs: [],
    shaders: [],
    techniques: [],
  };

  gltf.extensionsUsed.push("KHR_techniques_webgl");
  gltf.extensionsRequired.push("KHR_techniques_webgl");

  var primitiveByMaterial = ModelUtility.splitIncompatibleMaterials(gltf);

  ForEach.material(gltf, function (material, materialIndex) {
    var generatedMaterialValues = {};
    var technique = generateTechnique(
      gltf,
      material,
      materialIndex,
      generatedMaterialValues,
      primitiveByMaterial,
      options
    );

    if (!defined(material.extensions)) {
      material.extensions = {};
    }

    material.extensions.KHR_techniques_webgl = {
      values: generatedMaterialValues,
      technique: technique,
    };
  });

  // If any primitives have semantics that aren't declared in the generated
  // shaders, we want to preserve them.
  ModelUtility.ensureSemanticExistence(gltf);

  return gltf;
}

function isSpecularGlossinessMaterial(material) {
  return (
    defined(material.extensions) &&
    defined(material.extensions.KHR_materials_pbrSpecularGlossiness)
  );
}

function addTextureCoordinates(
  gltf,
  textureName,
  generatedMaterialValues,
  defaultTexCoord,
  result
) {
  var texCoord;
  if (defined(generatedMaterialValues[textureName + "Offset"])) {
    texCoord = textureName + "Coord";
    result.fragmentShaderMain +=
      "    vec2 " +
      texCoord +
      " = computeTexCoord(" +
      defaultTexCoord +
      ", " +
      textureName +
      "Offset, " +
      textureName +
      "Rotation, " +
      textureName +
      "Scale);\n";
  } else {
    texCoord = defaultTexCoord;
  }
  return texCoord;
}

var DEFAULT_TEXTURE_OFFSET = [0.0, 0.0];
var DEFAULT_TEXTURE_ROTATION = [0.0];
var DEFAULT_TEXTURE_SCALE = [1.0, 1.0];

function handleKHRTextureTransform(
  parameterName,
  value,
  generatedMaterialValues
) {
  if (
    parameterName.indexOf("Texture") === -1 ||
    !defined(value.extensions) ||
    !defined(value.extensions.KHR_texture_transform)
  ) {
    return;
  }

  var uniformName = "u_" + parameterName;
  var extension = value.extensions.KHR_texture_transform;
  generatedMaterialValues[uniformName + "Offset"] = defaultValue(
    extension.offset,
    DEFAULT_TEXTURE_OFFSET
  );
  generatedMaterialValues[uniformName + "Rotation"] = defaultValue(
    extension.rotation,
    DEFAULT_TEXTURE_ROTATION
  );
  generatedMaterialValues[uniformName + "Scale"] = defaultValue(
    extension.scale,
    DEFAULT_TEXTURE_SCALE
  );

  if (defined(value.texCoord) && defined(extension.texCoord)) {
    generatedMaterialValues[uniformName].texCoord = extension.texCoord;
  }
}

function generateTechnique(
  gltf,
  material,
  materialIndex,
  generatedMaterialValues,
  primitiveByMaterial,
  options
) {
  var addBatchIdToGeneratedShaders = defaultValue(
    options.addBatchIdToGeneratedShaders,
    false
  );

  var techniquesWebgl = gltf.extensions.KHR_techniques_webgl;
  var techniques = techniquesWebgl.techniques;
  var shaders = techniquesWebgl.shaders;
  var programs = techniquesWebgl.programs;

  var useSpecGloss = isSpecularGlossinessMaterial(material);
  var isSelfGltfRes = ExpandBySTC.isSelfGltf(gltf);

  var uniformName;
  var parameterName;
  var value;
  var pbrMetallicRoughness = material.pbrMetallicRoughness;
  if (defined(pbrMetallicRoughness) && !useSpecGloss) {
    for (parameterName in pbrMetallicRoughness) {
      if (pbrMetallicRoughness.hasOwnProperty(parameterName)) {
        value = pbrMetallicRoughness[parameterName];
        uniformName = "u_" + parameterName;
        generatedMaterialValues[uniformName] = value;
        handleKHRTextureTransform(
          parameterName,
          value,
          generatedMaterialValues
        );
      }
    }
  }

  if (useSpecGloss) {
    var pbrSpecularGlossiness =
      material.extensions.KHR_materials_pbrSpecularGlossiness;
    for (parameterName in pbrSpecularGlossiness) {
      if (pbrSpecularGlossiness.hasOwnProperty(parameterName)) {
        value = pbrSpecularGlossiness[parameterName];
        uniformName = "u_" + parameterName;
        generatedMaterialValues[uniformName] = value;
        handleKHRTextureTransform(
          parameterName,
          value,
          generatedMaterialValues
        );
      }
    }
  }

  for (var additional in material) {
    if (
      material.hasOwnProperty(additional) &&
      (additional.indexOf("Texture") >= 0 || additional.indexOf("Factor") >= 0)
    ) {
      value = material[additional];
      uniformName = "u_" + additional;
      generatedMaterialValues[uniformName] = value;
      handleKHRTextureTransform(additional, value, generatedMaterialValues);
    }
  }

  var vertexShader = "precision highp float;\n";
  var fragmentShader = "precision highp float;\n";

  var skin;
  if (defined(gltf.skins)) {
    skin = gltf.skins[0];
  }
  var joints = defined(skin) ? skin.joints : [];
  var jointCount = joints.length;

  var primitiveInfo = primitiveByMaterial[materialIndex];

  var skinningInfo;
  var hasSkinning = false;
  var hasVertexColors = false;
  var hasMorphTargets = false;
  var hasNormals = false;
  var hasTangents = false;
  var hasTexCoords = false;
  var hasOutline = false;
  var isUnlit = false;

  var isTrustGltf = (gltf &&gltf.asset && gltf.asset.generator && ExpandBySTC.trustGenerator.indexOf(gltf.asset.generator)>=0);
  if (defined(primitiveInfo)) {
    skinningInfo = primitiveInfo.skinning;
    hasSkinning = skinningInfo.skinned && joints.length > 0;
    hasVertexColors = primitiveInfo.hasVertexColors;
    hasMorphTargets = primitiveInfo.hasMorphTargets;
    hasNormals = primitiveInfo.hasNormals;
    hasTangents = primitiveInfo.hasTangents;
    hasTexCoords = primitiveInfo.hasTexCoords;
    hasOutline = primitiveInfo.hasOutline;
  }

  var morphTargets;
  if (hasMorphTargets) {
    ForEach.mesh(gltf, function (mesh) {
      ForEach.meshPrimitive(mesh, function (primitive) {
        if (primitive.material === materialIndex) {
          var targets = primitive.targets;
          if (defined(targets)) {
            morphTargets = targets;
          }
        }
      });
    });
  }

  // Add techniques
  var techniqueUniforms = {
    // Add matrices
    u_modelViewMatrix: {
      semantic: hasExtension(gltf, "CESIUM_RTC")
        ? "CESIUM_RTC_MODELVIEW"
        : "MODELVIEW",
      type: WebGLConstants.FLOAT_MAT4,
    },
    u_projectionMatrix: {
      semantic: "PROJECTION",
      type: WebGLConstants.FLOAT_MAT4,
    },
  };

  if (
    defined(material.extensions) &&
    defined(material.extensions.KHR_materials_unlit)
  ) {
    isUnlit = true;
    hasNormals = false;
    hasTangents = false;
  }

  if (hasNormals||isTrustGltf) {
    techniqueUniforms.u_normalMatrix = {
      semantic: "MODELVIEWINVERSETRANSPOSE",
      type: WebGLConstants.FLOAT_MAT3,
    };
  }

  if (hasSkinning) {
    techniqueUniforms.u_jointMatrix = {
      count: jointCount,
      semantic: "JOINTMATRIX",
      type: WebGLConstants.FLOAT_MAT4,
    };
  }

  if (hasMorphTargets) {
    techniqueUniforms.u_morphWeights = {
      count: morphTargets.length,
      semantic: "MORPHWEIGHTS",
      type: WebGLConstants.FLOAT,
    };
  }

  var alphaMode = material.alphaMode;
  if (defined(alphaMode) && alphaMode === "MASK") {
    techniqueUniforms.u_alphaCutoff = {
      semantic: "ALPHACUTOFF",
      type: WebGLConstants.FLOAT,
    };
  }

  // Add material values
  for (uniformName in generatedMaterialValues) {
    if (generatedMaterialValues.hasOwnProperty(uniformName)) {
      techniqueUniforms[uniformName] = {
        type: getPBRValueType(uniformName),
      };
    }
  }

  var baseColorUniform = defaultValue(
    techniqueUniforms.u_baseColorTexture,
    techniqueUniforms.u_baseColorFactor
  );
  if (defined(baseColorUniform)) {
    baseColorUniform.semantic = "_3DTILESDIFFUSE";
  }

  // Add uniforms to shaders
  for (uniformName in techniqueUniforms) {
    if (techniqueUniforms.hasOwnProperty(uniformName)) {
      var uniform = techniqueUniforms[uniformName];
      var arraySize = defined(uniform.count) ? "[" + uniform.count + "]" : "";
      if (
        (uniform.type !== WebGLConstants.FLOAT_MAT3 &&
          uniform.type !== WebGLConstants.FLOAT_MAT4 &&
          uniformName !== "u_morphWeights") ||
        uniform.useInFragment
      ) {
        fragmentShader +=
          "uniform " +
          webGLConstantToGlslType(uniform.type) +
          " " +
          uniformName +
          arraySize +
          ";\n";
        delete uniform.useInFragment;
      } else {
        vertexShader +=
          "uniform " +
          webGLConstantToGlslType(uniform.type) +
          " " +
          uniformName +
          arraySize +
          ";\n";
      }
    }
  }

  if (hasOutline) {
    fragmentShader += "uniform sampler2D u_outlineTexture;\n";
  }
  if(isTrustGltf){
      fragmentShader += 'uniform vec4 floodVar;\n';
      fragmentShader += 'uniform vec4 floodColor;\n';
  }

  // Add attributes with semantics
  var vertexShaderMain = "";
  if (hasSkinning) {
    vertexShaderMain +=
      "    mat4 skinMatrix =\n" +
      "        a_weight.x * u_jointMatrix[int(a_joint.x)] +\n" +
      "        a_weight.y * u_jointMatrix[int(a_joint.y)] +\n" +
      "        a_weight.z * u_jointMatrix[int(a_joint.z)] +\n" +
      "        a_weight.w * u_jointMatrix[int(a_joint.w)];\n";
  }

  // Add position always
  var techniqueAttributes = {
    a_position: {
      semantic: "POSITION",
    },
  };

  if (hasOutline) {
    techniqueAttributes.a_outlineCoordinates = {
      semantic: "_OUTLINE_COORDINATES",
    };
  }

  vertexShader += "attribute vec3 a_position;\n";
vertexShader += 'varying vec3 v_stcVertex;\n';
  if (gltf.appear === true) {
    vertexShader += 'uniform float gltfScaleZNum;\n';
  }
  if (ExpandBySTC.appearTiles) {
    vertexShader += 'uniform float bmScaleZNum;\n';
  }
  vertexShaderMain += '    v_stcVertex = a_position;\n';
  fragmentShader += 'varying vec3 v_stcVertex;\n';
  fragmentShader += 'uniform sampler2D u_styleBmImg;\n';
  if (hasNormals||isTrustGltf) {
    vertexShader += "varying vec3 v_positionEC;\n";
  }
  if (hasOutline) {
    vertexShader += "attribute vec3 a_outlineCoordinates;\n";
    vertexShader += "varying vec3 v_outlineCoordinates;\n";
  }

  // Morph Target Weighting
  vertexShaderMain += "    vec3 weightedPosition = a_position;\n";
  if (ExpandBySTC.appearTiles && !gltf.appear) {
    vertexShaderMain += '    weightedPosition.z *= bmScaleZNum;\n';
  }
  if(gltf.appear === true){
    vertexShaderMain += '    weightedPosition.z *= gltfScaleZNum;\n';
  }
  if (hasNormals) {
    vertexShaderMain += "    vec3 weightedNormal = a_normal;\n";
  }
  if (hasTangents) {
    vertexShaderMain += "    vec4 weightedTangent = a_tangent;\n";
  }
  if (hasMorphTargets) {
    for (var k = 0; k < morphTargets.length; k++) {
      var targetAttributes = morphTargets[k];
      for (var targetAttribute in targetAttributes) {
        if (
          targetAttributes.hasOwnProperty(targetAttribute) &&
          targetAttribute !== "extras"
        ) {
          var attributeName = "a_" + targetAttribute + "_" + k;
          techniqueAttributes[attributeName] = {
            semantic: targetAttribute + "_" + k,
          };
          vertexShader += "attribute vec3 " + attributeName + ";\n";
          if (targetAttribute === "POSITION") {
            vertexShaderMain +=
              "    weightedPosition += u_morphWeights[" +
              k +
              "] * " +
              attributeName +
              ";\n";
          } else if (targetAttribute === "NORMAL") {
            vertexShaderMain +=
              "    weightedNormal += u_morphWeights[" +
              k +
              "] * " +
              attributeName +
              ";\n";
          } else if (hasTangents && targetAttribute === "TANGENT") {
            vertexShaderMain +=
              "    weightedTangent.xyz += u_morphWeights[" +
              k +
              "] * " +
              attributeName +
              ";\n";
          }
        }
      }
    }
  }

  // Final position computation
  if (hasSkinning) {
    vertexShaderMain +=
      "    vec4 position = skinMatrix * vec4(weightedPosition, 1.0);\n";
  } else {
    vertexShaderMain += "    vec4 position = vec4(weightedPosition, 1.0);\n";
  }
  vertexShaderMain += "    position = u_modelViewMatrix * position;\n";
  if (hasNormals) {
    vertexShaderMain += "    v_positionEC = position.xyz;\n";
  }


  


  if(isTrustGltf){
    fragmentShader += 'uniform sampler2D u_tailorTilesArea;\n';
    fragmentShader += 'uniform mat4 u_inverTailorTilesCenterMat;\n';
    fragmentShader += 'uniform mat4 u_currModelMatrix;\n';
    fragmentShader += 'uniform bool u_enableTailorTiles;\n';
    fragmentShader += 'uniform bool u_enableBrightTiles;\n';
    fragmentShader += 'uniform float u_contrast;\n';
    fragmentShader += 'uniform vec4 u_tailorTilesRect;\n';
  }


  vertexShaderMain += "    gl_Position = u_projectionMatrix * position;\n";

  if (hasOutline) {
    vertexShaderMain += "    v_outlineCoordinates = a_outlineCoordinates;\n";
  }

  // Final normal computation
  if (hasNormals) {
    techniqueAttributes.a_normal = {
      semantic: "NORMAL",
    };
    vertexShader += "attribute vec3 a_normal;\n";
    vertexShader += "varying vec3 v_normal;\n";
    if (hasSkinning) {
      vertexShaderMain +=
        "    v_normal = u_normalMatrix * mat3(skinMatrix) * weightedNormal;\n";
    } else {
      vertexShaderMain += "    v_normal = u_normalMatrix * weightedNormal;\n";
    }

    fragmentShader += "varying vec3 v_normal;\n";
    fragmentShader += "varying vec3 v_positionEC;\n";
  }

  // Read tangents if available
  if (hasTangents) {
    techniqueAttributes.a_tangent = {
      semantic: "TANGENT",
    };
    vertexShader += "attribute vec4 a_tangent;\n";
    vertexShader += "varying vec4 v_tangent;\n";
    vertexShaderMain +=
      "    v_tangent.xyz = u_normalMatrix * weightedTangent.xyz;\n";
    vertexShaderMain += "    v_tangent.w = weightedTangent.w;\n";

    fragmentShader += "varying vec4 v_tangent;\n";
  }

  if (hasOutline) {
    fragmentShader += "varying vec3 v_outlineCoordinates;\n";
  }

  var fragmentShaderMain = "";

  // Add texture coordinates if the material uses them
  var v_texCoord;
  var normalTexCoord;
  var baseColorTexCoord;
  var specularGlossinessTexCoord;
  var diffuseTexCoord;
  var metallicRoughnessTexCoord;
  var occlusionTexCoord;
  var emissiveTexCoord;

  if (hasTexCoords) {
    techniqueAttributes.a_texcoord_0 = {
      semantic: "TEXCOORD_0",
    };

    v_texCoord = "v_texcoord_0";
    vertexShader += "attribute vec2 a_texcoord_0;\n";
    vertexShader += "varying vec2 " + v_texCoord + ";\n";
    vertexShaderMain += "    " + v_texCoord + " = a_texcoord_0;\n";

    fragmentShader += "varying vec2 " + v_texCoord + ";\n";

    var result = {
      fragmentShaderMain: fragmentShaderMain,
    };
    normalTexCoord = addTextureCoordinates(
      gltf,
      "u_normalTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    baseColorTexCoord = addTextureCoordinates(
      gltf,
      "u_baseColorTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    specularGlossinessTexCoord = addTextureCoordinates(
      gltf,
      "u_specularGlossinessTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    diffuseTexCoord = addTextureCoordinates(
      gltf,
      "u_diffuseTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    metallicRoughnessTexCoord = addTextureCoordinates(
      gltf,
      "u_metallicRoughnessTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    occlusionTexCoord = addTextureCoordinates(
      gltf,
      "u_occlusionTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );
    emissiveTexCoord = addTextureCoordinates(
      gltf,
      "u_emmissiveTexture",
      generatedMaterialValues,
      v_texCoord,
      result
    );

    fragmentShaderMain = result.fragmentShaderMain;
  }

  // Add skinning information if available
  if (hasSkinning) {
    techniqueAttributes.a_joint = {
      semantic: "JOINTS_0",
    };
    techniqueAttributes.a_weight = {
      semantic: "WEIGHTS_0",
    };

    vertexShader += "attribute vec4 a_joint;\n";
    vertexShader += "attribute vec4 a_weight;\n";
  }

  if (hasVertexColors) {
    techniqueAttributes.a_vertexColor = {
      semantic: "COLOR_0",
    };
    vertexShader += "attribute vec4 a_vertexColor;\n";
    vertexShader += "varying vec4 v_vertexColor;\n";
    vertexShaderMain += "  v_vertexColor = a_vertexColor;\n";
    fragmentShader += "varying vec4 v_vertexColor;\n";
  }

  if (addBatchIdToGeneratedShaders) {
    techniqueAttributes.a_batchId = {
      semantic: "_BATCHID",
    };
    vertexShader += "attribute float a_batchId;\n";
  }

vertexShader += 'void main(void) \n{\n';

  vertexShader += vertexShaderMain;
  vertexShader += "}\n";

  // Fragment shader lighting
  if (hasNormals) {
    fragmentShader += "const float M_PI = 3.141592653589793;\n";

    fragmentShader +=
      "vec3 lambertianDiffuse(vec3 diffuseColor) \n" +
      "{\n" +
      "    return diffuseColor / M_PI;\n" +
      "}\n\n";

    fragmentShader +=
      "vec3 fresnelSchlick2(vec3 f0, vec3 f90, float VdotH) \n" +
      "{\n" +
      "    return f0 + (f90 - f0) * pow(clamp(1.0 - VdotH, 0.0, 1.0), 5.0);\n" +
      "}\n\n";

    fragmentShader +=
      "vec3 fresnelSchlick(float metalness, float VdotH) \n" +
      "{\n" +
      "    return metalness + (vec3(1.0) - metalness) * pow(1.0 - VdotH, 5.0);\n" +
      "}\n\n";

    fragmentShader +=
      "float smithVisibilityG1(float NdotV, float roughness) \n" +
      "{\n" +
      "    float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;\n" +
      "    return NdotV / (NdotV * (1.0 - k) + k);\n" +
      "}\n\n";

    fragmentShader +=
      "float smithVisibilityGGX(float roughness, float NdotL, float NdotV) \n" +
      "{\n" +
      "    return smithVisibilityG1(NdotL, roughness) * smithVisibilityG1(NdotV, roughness);\n" +
      "}\n\n";

    fragmentShader +=
      "float GGX(float roughness, float NdotH) \n" +
      "{\n" +
      "    float roughnessSquared = roughness * roughness;\n" +
      "    float f = (NdotH * roughnessSquared - NdotH) * NdotH + 1.0;\n" +
      "    return roughnessSquared / (M_PI * f * f);\n" +
      "}\n\n";
  }

  fragmentShader +=
    "vec3 SRGBtoLINEAR3(vec3 srgbIn) \n" +
    "{\n" +
    "    return pow(srgbIn, vec3(2.2));\n" +
    "}\n\n";

  fragmentShader +=
    "vec4 SRGBtoLINEAR4(vec4 srgbIn) \n" +
    "{\n" +
    "    vec3 linearOut = pow(srgbIn.rgb, vec3(2.2));\n" +
    "    return vec4(linearOut, srgbIn.a);\n" +
    "}\n\n";

  fragmentShader +=
    "vec3 applyTonemapping(vec3 linearIn) \n" +
    "{\n" +
    "#ifndef HDR \n" +
    "    return czm_acesTonemapping(linearIn);\n" +
    "#else \n" +
    "    return linearIn;\n" +
    "#endif \n" +
    "}\n\n";

  fragmentShader +=
    "vec3 LINEARtoSRGB(vec3 linearIn) \n" +
    "{\n" +
    "#ifndef HDR \n" +
    "    return pow(linearIn, vec3(1.0/2.2));\n" +
    "#else \n" +
    "    return linearIn;\n" +
    "#endif \n" +
    "}\n\n";

  fragmentShader +=
    "vec2 computeTexCoord(vec2 texCoords, vec2 offset, float rotation, vec2 scale) \n" +
    "{\n" +
    "    rotation = -rotation; \n" +
    "    mat3 transform = mat3(\n" +
    "        cos(rotation) * scale.x, sin(rotation) * scale.x, 0.0, \n" +
    "       -sin(rotation) * scale.y, cos(rotation) * scale.y, 0.0, \n" +
    "        offset.x, offset.y, 1.0); \n" +
    "    vec2 transformedTexCoords = (transform * vec3(fract(texCoords), 1.0)).xy; \n" +
    "    return transformedTexCoords; \n" +
    "}\n\n";

  fragmentShader += "#ifdef USE_IBL_LIGHTING \n";
  fragmentShader += "uniform vec2 gltf_iblFactor; \n";
  fragmentShader += "#endif \n";
  fragmentShader += "#ifdef USE_CUSTOM_LIGHT_COLOR \n";
  fragmentShader += "uniform vec3 gltf_lightColor; \n";
  fragmentShader += "#endif \n";

  fragmentShader += "void main(void) \n{\n";
  fragmentShader += fragmentShaderMain;

  // Add normal mapping to fragment shader
  if (hasNormals) {
    fragmentShader += "    vec3 ng = normalize(v_normal);\n";
    fragmentShader +=
      "    vec3 positionWC = vec3(czm_inverseView * vec4(v_positionEC, 1.0));\n";
    if (defined(generatedMaterialValues.u_normalTexture)) {
      if (hasTangents) {
        // Read tangents from varying
        fragmentShader += "    vec3 t = normalize(v_tangent.xyz);\n";
        fragmentShader +=
          "    vec3 b = normalize(cross(ng, t) * v_tangent.w);\n";
        fragmentShader += "    mat3 tbn = mat3(t, b, ng);\n";
        fragmentShader +=
          "    vec3 n = texture2D(u_normalTexture, " +
          normalTexCoord +
          ").rgb;\n";
        fragmentShader += "    n = normalize(tbn * (2.0 * n - 1.0));\n";
      } else {
        // Add standard derivatives extension
        fragmentShader =
          "#ifdef GL_OES_standard_derivatives\n" +
          "#extension GL_OES_standard_derivatives : enable\n" +
          "#endif\n" +
          fragmentShader;
        // Compute tangents
        fragmentShader += "#ifdef GL_OES_standard_derivatives\n";
        fragmentShader += "    vec3 pos_dx = dFdx(v_positionEC);\n";
        fragmentShader += "    vec3 pos_dy = dFdy(v_positionEC);\n";
        fragmentShader +=
          "    vec3 tex_dx = dFdx(vec3(" + normalTexCoord + ",0.0));\n";
        fragmentShader +=
          "    vec3 tex_dy = dFdy(vec3(" + normalTexCoord + ",0.0));\n";
        fragmentShader +=
          "    vec3 t = (tex_dy.t * pos_dx - tex_dx.t * pos_dy) / (tex_dx.s * tex_dy.t - tex_dy.s * tex_dx.t);\n";
        fragmentShader += "    t = normalize(t - ng * dot(ng, t));\n";
        fragmentShader += "    vec3 b = normalize(cross(ng, t));\n";
        fragmentShader += "    mat3 tbn = mat3(t, b, ng);\n";
        fragmentShader +=
          "    vec3 n = texture2D(u_normalTexture, " +
          normalTexCoord +
          ").rgb;\n";
        fragmentShader += "    n = normalize(tbn * (2.0 * n - 1.0));\n";
        fragmentShader += "#else\n";
        fragmentShader += "    vec3 n = ng;\n";
        fragmentShader += "#endif\n";
      }
    } else {
      fragmentShader += "    vec3 n = ng;\n";
    }
    if (material.doubleSided) {
      fragmentShader += "    if (czm_backFacing())\n";
      fragmentShader += "    {\n";
      fragmentShader += "        n = -n;\n";
      fragmentShader += "    }\n";
    }
  }

  // Add base color to fragment shader
  if (defined(generatedMaterialValues.u_baseColorTexture)) {
    fragmentShader += "float uvNum = 0.0;";
      if (gltf.uvMove === true) {
          fragmentShader += "uvNum = fract(czm_frameNumber/100.0);";
      }
      // fragmentShader +=
      //   "    vec4 baseColorWithAlpha = SRGBtoLINEAR4(texture2D(u_baseColorTexture, " +
      //   baseColorTexCoord +
      //   "));\n";

      fragmentShader += '    vec4 baseColorWithAlpha = SRGBtoLINEAR4(texture2D(u_baseColorTexture, ' + baseColorTexCoord + ' + vec2(0.0,uvNum)));\n';
      if (gltf.useGradient) {
        var baseC = gltf.baseColor || Color.WHITE;
        // fragmentShader += "    baseColorWithAlpha = vec4(1.0);\n";
        fragmentShader += "    baseColorWithAlpha = vec4(" + baseC.red + "," + baseC.green + "," + baseC.blue + "," + baseC.alpha + ");\n";
      }
        var stcnum = 1;
        stcnum = gltf.mixNum || stcnum;
        stcnum = stcnum;
      if (defined(generatedMaterialValues.u_baseColorFactor)) {
        fragmentShader += "    baseColorWithAlpha *= u_baseColorFactor;\n";
      }

      if (gltf.useGradient) {
        var stc = gltf.mixColor || Color.WHITE;
        fragmentShader += "    vec4 mixColor = vec4(" + stc.red + "," + stc.green + "," + stc.blue + "," + stcnum + ");\n";
        fragmentShader += "    mixColor.a = mixColor.a*(1.0 - " + baseColorTexCoord + ".t);\n";
        fragmentShader += "    baseColorWithAlpha = vec4(mix(mixColor.rgb, baseColorWithAlpha.rgb, clamp(0.0,1.0,mixColor.a)),1.0);\n";
      }
  } else if (defined(generatedMaterialValues.u_baseColorFactor)) {
    fragmentShader += "    vec4 baseColorWithAlpha = u_baseColorFactor;\n";
  } else {
    fragmentShader += "    vec4 baseColorWithAlpha = vec4(1.0);\n";
  }

  if (hasVertexColors) {
    fragmentShader += "    baseColorWithAlpha *= v_vertexColor;\n";
  }

  fragmentShader += "    vec3 baseColor = baseColorWithAlpha.rgb;\n";
  if (gltf.ableCustomLight) {
    fragmentShader += "    baseColor = czm_stcAmbientLight(baseColor);";
  }

  if (hasNormals) {
    if (useSpecGloss) {
      if (defined(generatedMaterialValues.u_specularGlossinessTexture)) {
        fragmentShader +=
          "    vec4 specularGlossiness = SRGBtoLINEAR4(texture2D(u_specularGlossinessTexture, " +
          specularGlossinessTexCoord +
          "));\n";
        fragmentShader += "    vec3 specular = specularGlossiness.rgb;\n";
        fragmentShader += "    float glossiness = specularGlossiness.a;\n";
        if (defined(generatedMaterialValues.u_specularFactor)) {
          fragmentShader += "    specular *= u_specularFactor;\n";
        }
        if (defined(generatedMaterialValues.u_glossinessFactor)) {
          fragmentShader += "    glossiness *= u_glossinessFactor;\n";
        }
      } else {
        if (defined(generatedMaterialValues.u_specularFactor)) {
          fragmentShader +=
            "    vec3 specular = clamp(u_specularFactor, vec3(0.0), vec3(1.0));\n";
        } else {
          fragmentShader += "    vec3 specular = vec3(1.0);\n";
        }
        if (defined(generatedMaterialValues.u_glossinessFactor)) {
          fragmentShader +=
            "    float glossiness = clamp(u_glossinessFactor, 0.0, 1.0);\n";
        } else {
          fragmentShader += "    float glossiness = 1.0;\n";
        }
      }
      if (defined(generatedMaterialValues.u_diffuseTexture)) {
        fragmentShader +=
          "    vec4 diffuse = SRGBtoLINEAR4(texture2D(u_diffuseTexture, " +
          diffuseTexCoord +
          "));\n";
        if (defined(generatedMaterialValues.u_diffuseFactor)) {
          fragmentShader += "    diffuse *= u_diffuseFactor;\n";
        }
      } else if (defined(generatedMaterialValues.u_diffuseFactor)) {
        fragmentShader +=
          "    vec4 diffuse = clamp(u_diffuseFactor, vec4(0.0), vec4(1.0));\n";
      } else {
        fragmentShader += "    vec4 diffuse = vec4(1.0);\n";
      }
    } else if (defined(generatedMaterialValues.u_metallicRoughnessTexture)) {
      fragmentShader +=
        "    vec3 metallicRoughness = texture2D(u_metallicRoughnessTexture, " +
        metallicRoughnessTexCoord +
        ").rgb;\n";
      fragmentShader +=
        "    float metalness = clamp(metallicRoughness.b, 0.0, 1.0);\n";
      fragmentShader +=
        "    float roughness = clamp(metallicRoughness.g, 0.04, 1.0);\n";
      if (defined(generatedMaterialValues.u_metallicFactor)) {
        fragmentShader += "    metalness *= u_metallicFactor;\n";
      }
      if (defined(generatedMaterialValues.u_roughnessFactor)) {
        fragmentShader += "    roughness *= u_roughnessFactor;\n";
      }
    } else {
      if (defined(generatedMaterialValues.u_metallicFactor)) {
        fragmentShader +=
          "    float metalness = clamp(u_metallicFactor, 0.0, 1.0);\n";
      } else {
        fragmentShader += "    float metalness = 1.0;\n";
      }
      if (defined(generatedMaterialValues.u_roughnessFactor)) {
        fragmentShader +=
          "    float roughness = clamp(u_roughnessFactor, 0.04, 1.0);\n";
      } else {
        fragmentShader += "    float roughness = 1.0;\n";
      }
      if (gltf.customMetalness && gltf.customMetalness.toFixed(2)) {
        fragmentShader += "    metalness = " + gltf.customMetalness.toFixed(2) + ";\n";
      }
      
      if (gltf.customRoughness && gltf.customRoughness.toFixed(2)) {
        fragmentShader += "    roughness = " + gltf.customRoughness.toFixed(2) + ";\n";
      }
    }

    fragmentShader += "    vec3 v = -normalize(v_positionEC);\n";

    // Generate fragment shader's lighting block
    fragmentShader += "#ifndef USE_CUSTOM_LIGHT_COLOR \n";
    fragmentShader += "    vec3 lightColorHdr = czm_lightColorHdr;\n";
    fragmentShader += "#else \n";
    fragmentShader += "    vec3 lightColorHdr = gltf_lightColor;\n";
    fragmentShader += "#endif \n";
    fragmentShader += "    vec3 l = normalize(czm_lightDirectionEC);\n";
    fragmentShader += "    vec3 h = normalize(v + l);\n";
    fragmentShader += "    float NdotL = clamp(dot(n, l), 0.001, 1.0) / 20.0;\n";
    fragmentShader += "    float NdotV = abs(dot(n, v)) / 20.0 + 0.001;\n";
    fragmentShader += "    float NdotH = clamp(dot(n, h), 0.0, 1.0) / 20.0;\n";
    fragmentShader += "    float LdotH = clamp(dot(l, h), 0.0, 1.0) / 20.0;\n";
    fragmentShader += "    float VdotH = clamp(dot(v, h), 0.0, 1.0) / 20.0;\n";
    fragmentShader += "    vec3 f0 = vec3(0.04);\n";
    // Whether the material uses metallic-roughness or specular-glossiness changes how the BRDF inputs are computed.
    // It does not change the implementation of the BRDF itself.
    if (useSpecGloss) {
      fragmentShader += "    float roughness = 1.0 - glossiness;\n";
      fragmentShader +=
        "    vec3 diffuseColor = diffuse.rgb * (1.0 - max(max(specular.r, specular.g), specular.b));\n";
      fragmentShader += "    vec3 specularColor = specular;\n";
    } else {
      fragmentShader +=
        "    vec3 diffuseColor = baseColor * (1.0 - metalness) * (1.0 - f0);\n";
      fragmentShader +=
        "    vec3 specularColor = mix(f0, baseColor, metalness);\n";
    }

    fragmentShader += "    float alpha = roughness * roughness;\n";
    fragmentShader +=
      "    float reflectance = max(max(specularColor.r, specularColor.g), specularColor.b);\n";
    fragmentShader +=
      "    vec3 r90 = vec3(clamp(reflectance * 25.0, 0.0, 1.0));\n";
    fragmentShader += "    vec3 r0 = specularColor.rgb;\n";

    fragmentShader += "    vec3 F = fresnelSchlick2(r0, r90, VdotH);\n";
    fragmentShader +=
      "    float G = smithVisibilityGGX(alpha, NdotL, NdotV);\n";
    fragmentShader += "    float D = GGX(alpha, NdotH);\n";

    fragmentShader +=
      "    vec3 diffuseContribution = (1.0 - F) * lambertianDiffuse(diffuseColor);\n";
    fragmentShader +=
      "    vec3 specularContribution = F * G * D / (4.0 * NdotL * NdotV);\n";
    fragmentShader +=
      "    vec3 color = NdotL * lightColorHdr * (diffuseContribution + specularContribution);\n";

    if (gltf.ableCustomLight) {
      fragmentShader += "czm_geometryInput geometry;\n";
      fragmentShader += "geometry.normal = n;\n";
      fragmentShader += "geometry.metalness = metalness;\n";
      fragmentShader += "geometry.roughness = roughness;\n";
      fragmentShader += "geometry.color = baseColor;\n";

      fragmentShader += "czm_pointLightInput light;\n";
      fragmentShader += "light.position = czm_extendPointLightPositionEC;\n";
      fragmentShader += "light.intensity = czm_extendPointLightBrightness;\n";
      fragmentShader += "light.dis = czm_extendPointLightDistance;\n";
      fragmentShader += "light.color = czm_extendPointLightColor;\n";

      fragmentShader += "czm_spotLightInput spotlight;\n";
      fragmentShader += "spotlight.position = czm_extendSpotLightPositionEC;\n";
      fragmentShader += "spotlight.intensity = czm_extendSpotLightBrightness;\n";
      fragmentShader += "spotlight.dis = czm_extendSpotLightDistance;\n";
      fragmentShader += "spotlight.color = czm_extendSpotLightColor;\n";
      fragmentShader += "spotlight.direction = czm_extendSpotLightDirectionEC;\n";
      fragmentShader += "spotlight.angle = czm_extendSpotLightCosNum;\n";

      fragmentShader += "czm_parallelLightInput parallel1;\n";
      fragmentShader += "parallel1.intensity = czm_extendParallelLight1Brightness;\n";
      fragmentShader += "parallel1.enable = czm_extendParallelLight1Enable;\n";
      fragmentShader += "parallel1.color = czm_extendParallelLight1Color;\n";
      fragmentShader += "parallel1.direction = czm_extendParallelLight1Direction;\n";

      fragmentShader += "czm_parallelLightInput parallel2;\n";
      fragmentShader += "parallel2.intensity = czm_extendParallelLight2Brightness;\n";
      fragmentShader += "parallel2.enable = czm_extendParallelLight2Enable;\n";
      fragmentShader += "parallel2.color = czm_extendParallelLight2Color;\n";
      fragmentShader += "parallel2.direction = czm_extendParallelLight2Direction;\n";

      fragmentShader += "    color += czm_stcPointLight(v_positionEC, geometry, light);\n";
      fragmentShader += "    color += czm_stcSpotLight(v_positionEC, geometry, spotlight);\n";
      fragmentShader += "    color += czm_stcParallelLight(v_positionEC, geometry, parallel1);\n";
      fragmentShader += "    color += czm_stcParallelLight(v_positionEC, geometry, parallel2);\n";
    }

    // Use the procedural IBL if there are no environment maps
    fragmentShader +=
      "#if defined(USE_IBL_LIGHTING) && !defined(DIFFUSE_IBL) && !defined(SPECULAR_IBL) \n";

    fragmentShader +=
      "    vec3 r = normalize(czm_inverseViewRotation * normalize(reflect(v, n)));\n";
    // Figure out if the reflection vector hits the ellipsoid
    fragmentShader += "    float vertexRadius = length(positionWC);\n";
    fragmentShader +=
      "    float horizonDotNadir = 1.0 - min(1.0, czm_ellipsoidRadii.x / vertexRadius);\n";
    fragmentShader +=
      "    float reflectionDotNadir = dot(r, normalize(positionWC));\n";
    // Flipping the X vector is a cheap way to get the inverse of czm_temeToPseudoFixed, since that's a rotation about Z.
    fragmentShader += "    r.x = -r.x;\n";
    fragmentShader += "    r = -normalize(czm_temeToPseudoFixed * r);\n";
    fragmentShader += "    r.x = -r.x;\n";

    fragmentShader += "    float inverseRoughness = 1.04 - roughness;\n";
    fragmentShader += "    inverseRoughness *= inverseRoughness;\n";
    fragmentShader +=
      "    vec3 sceneSkyBox = textureCube(czm_environmentMap, r).rgb * inverseRoughness;\n";

    fragmentShader += "    float atmosphereHeight = 0.05;\n";
    fragmentShader +=
      "    float blendRegionSize = 0.1 * ((1.0 - inverseRoughness) * 8.0 + 1.1 - horizonDotNadir);\n";
    fragmentShader += "    float blendRegionOffset = roughness * -1.0;\n";
    fragmentShader +=
      "    float farAboveHorizon = clamp(horizonDotNadir - blendRegionSize * 0.5 + blendRegionOffset, 1.0e-10 - blendRegionSize, 0.99999);\n";
    fragmentShader +=
      "    float aroundHorizon = clamp(horizonDotNadir + blendRegionSize * 0.5, 1.0e-10 - blendRegionSize, 0.99999);\n";
    fragmentShader +=
      "    float farBelowHorizon = clamp(horizonDotNadir + blendRegionSize * 1.5, 1.0e-10 - blendRegionSize, 0.99999);\n";
    fragmentShader +=
      "    float smoothstepHeight = smoothstep(0.0, atmosphereHeight, horizonDotNadir);\n";

    fragmentShader +=
      "    vec3 belowHorizonColor = mix(vec3(0.1, 0.15, 0.25), vec3(0.4, 0.7, 0.9), smoothstepHeight);\n";
    fragmentShader += "    vec3 nadirColor = belowHorizonColor * 0.5;\n";
    fragmentShader +=
      "    vec3 aboveHorizonColor = mix(vec3(0.9, 1.0, 1.2), belowHorizonColor, roughness * 0.5);\n";
    fragmentShader +=
      "    vec3 blueSkyColor = mix(vec3(0.18, 0.26, 0.48), aboveHorizonColor, reflectionDotNadir * inverseRoughness * 0.5 + 0.75);\n";
    fragmentShader +=
      "    vec3 zenithColor = mix(blueSkyColor, sceneSkyBox, smoothstepHeight);\n";

    fragmentShader += "    vec3 blueSkyDiffuseColor = vec3(0.7, 0.85, 0.9);\n";
    fragmentShader +=
      "    float diffuseIrradianceFromEarth = (1.0 - horizonDotNadir) * (reflectionDotNadir * 0.25 + 0.75) * smoothstepHeight;\n";
    fragmentShader +=
      "    float diffuseIrradianceFromSky = (1.0 - smoothstepHeight) * (1.0 - (reflectionDotNadir * 0.25 + 0.25));\n";
    fragmentShader +=
      "    vec3 diffuseIrradiance = blueSkyDiffuseColor * clamp(diffuseIrradianceFromEarth + diffuseIrradianceFromSky, 0.0, 1.0);\n";

    fragmentShader +=
      "    float notDistantRough = (1.0 - horizonDotNadir * roughness * 0.8);\n";
    fragmentShader +=
      "    vec3 specularIrradiance = mix(zenithColor, aboveHorizonColor, smoothstep(farAboveHorizon, aroundHorizon, reflectionDotNadir) * notDistantRough);\n";
    fragmentShader +=
      "    specularIrradiance = mix(specularIrradiance, belowHorizonColor, smoothstep(aroundHorizon, farBelowHorizon, reflectionDotNadir) * inverseRoughness);\n";
    fragmentShader +=
      "    specularIrradiance = mix(specularIrradiance, nadirColor, smoothstep(farBelowHorizon, 1.0, reflectionDotNadir) * inverseRoughness);\n";

    // Luminance model from page 40 of http://silviojemma.com/public/papers/lighting/spherical-harmonic-lighting.pdf
    fragmentShader += "#ifdef USE_SUN_LUMINANCE \n";
    // Angle between sun and zenith
    fragmentShader +=
      "    float LdotZenith = clamp(dot(normalize(czm_inverseViewRotation * l), normalize(positionWC * -1.0)), 0.001, 1.0);\n";
    fragmentShader += "    float S = acos(LdotZenith);\n";
    // Angle between zenith and current pixel
    fragmentShader +=
      "    float NdotZenith = clamp(dot(normalize(czm_inverseViewRotation * n), normalize(positionWC * -1.0)), 0.001, 1.0);\n";
    // Angle between sun and current pixel
    fragmentShader += "    float gamma = acos(NdotL);\n";
    fragmentShader +=
      "    float numerator = ((0.91 + 10.0 * exp(-3.0 * gamma) + 0.45 * pow(NdotL, 2.0)) * (1.0 - exp(-0.32 / NdotZenith)));\n";
    fragmentShader +=
      "    float denominator = (0.91 + 10.0 * exp(-3.0 * S) + 0.45 * pow(LdotZenith,2.0)) * (1.0 - exp(-0.32));\n";
    fragmentShader +=
      "    float luminance = gltf_luminanceAtZenith * (numerator / denominator);\n";
    fragmentShader += "#endif \n";

    fragmentShader +=
      "    vec2 brdfLut = texture2D(czm_brdfLut, vec2(NdotV, roughness)).rg;\n";
    fragmentShader +=
      "    vec3 IBLColor = (diffuseIrradiance * diffuseColor * gltf_iblFactor.x) + (specularIrradiance * SRGBtoLINEAR3(specularColor * brdfLut.x + brdfLut.y) * gltf_iblFactor.y);\n";

    fragmentShader +=
      "    float maximumComponent = max(max(lightColorHdr.x, lightColorHdr.y), lightColorHdr.z);\n";
    fragmentShader +=
      "    vec3 lightColor = lightColorHdr / max(maximumComponent, 1.0);\n";
    fragmentShader += "    IBLColor *= lightColor;\n";

    fragmentShader += "#ifdef USE_SUN_LUMINANCE \n";
    fragmentShader += "    color += IBLColor * luminance;\n";
    fragmentShader += "#else \n";
    fragmentShader += "    color += IBLColor; \n";
    fragmentShader += "#endif \n";

    // Environment maps were provided, use them for IBL
    fragmentShader += "#elif defined(DIFFUSE_IBL) || defined(SPECULAR_IBL) \n";

    fragmentShader +=
      "    mat3 fixedToENU = mat3(gltf_clippingPlanesMatrix[0][0], gltf_clippingPlanesMatrix[1][0], gltf_clippingPlanesMatrix[2][0], \n";
    fragmentShader +=
      "                           gltf_clippingPlanesMatrix[0][1], gltf_clippingPlanesMatrix[1][1], gltf_clippingPlanesMatrix[2][1], \n";
    fragmentShader +=
      "                           gltf_clippingPlanesMatrix[0][2], gltf_clippingPlanesMatrix[1][2], gltf_clippingPlanesMatrix[2][2]); \n";
    fragmentShader +=
      "    const mat3 yUpToZUp = mat3(-1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0); \n";
    fragmentShader +=
      "    vec3 cubeDir = normalize(yUpToZUp * fixedToENU * normalize(reflect(-v, n))); \n";

    fragmentShader += "#ifdef DIFFUSE_IBL \n";
    fragmentShader += "#ifdef CUSTOM_SPHERICAL_HARMONICS \n";
    fragmentShader +=
      "    vec3 diffuseIrradiance = czm_sphericalHarmonics(cubeDir, gltf_sphericalHarmonicCoefficients); \n";
    fragmentShader += "#else \n";
    fragmentShader +=
      "    vec3 diffuseIrradiance = czm_sphericalHarmonics(cubeDir, czm_sphericalHarmonicCoefficients); \n";
    fragmentShader += "#endif \n";
    fragmentShader += "#else \n";
    fragmentShader += "    vec3 diffuseIrradiance = vec3(0.0); \n";
    fragmentShader += "#endif \n";

    fragmentShader += "#ifdef SPECULAR_IBL \n";
    fragmentShader +=
      "    vec2 brdfLut = texture2D(czm_brdfLut, vec2(NdotV, roughness)).rg;\n";
    fragmentShader += "#ifdef CUSTOM_SPECULAR_IBL \n";
    fragmentShader +=
      "    vec3 specularIBL = czm_sampleOctahedralProjection(gltf_specularMap, gltf_specularMapSize, cubeDir,  roughness * gltf_maxSpecularLOD, gltf_maxSpecularLOD);\n";
    fragmentShader += "#else \n";
    fragmentShader +=
      "    vec3 specularIBL = czm_sampleOctahedralProjection(czm_specularEnvironmentMaps, czm_specularEnvironmentMapSize, cubeDir,  roughness * czm_specularEnvironmentMapsMaximumLOD, czm_specularEnvironmentMapsMaximumLOD);\n";
    fragmentShader += "#endif \n";
    fragmentShader += "    specularIBL *= F * brdfLut.x + brdfLut.y;\n";
    fragmentShader += "#else \n";
    fragmentShader += "    vec3 specularIBL = vec3(0.0); \n";
    fragmentShader += "#endif \n";

    fragmentShader +=
      "    color += diffuseIrradiance * diffuseColor + specularColor * specularIBL;\n";

    fragmentShader += "#endif \n";
  } else {
    fragmentShader += "    vec3 color = baseColor;\n";
  }

  // Ignore occlusion and emissive when unlit
  if (!isUnlit) {
    if (defined(generatedMaterialValues.u_occlusionTexture)) {
      fragmentShader +=
        "    color *= texture2D(u_occlusionTexture, " +
        occlusionTexCoord +
        ").r;\n";
    }
    if (defined(generatedMaterialValues.u_emissiveTexture)) {
      fragmentShader +=
        "    vec3 emissive = SRGBtoLINEAR3(texture2D(u_emissiveTexture, " +
        emissiveTexCoord +
        ").rgb);\n";
      if (defined(generatedMaterialValues.u_emissiveFactor)) {
        fragmentShader += "    emissive *= u_emissiveFactor;\n";
      }
      fragmentShader += "    color += emissive;\n";
    } else if (defined(generatedMaterialValues.u_emissiveFactor)) {
      fragmentShader += "    color += u_emissiveFactor;\n";
    }
  }

  if (!isUnlit) {
    fragmentShader += "    color = applyTonemapping(color);\n";
  }

  fragmentShader += "    color = LINEARtoSRGB(color);\n";

  if (hasOutline) {
    fragmentShader += "    float outlineness = max(\n";
    fragmentShader +=
      "        texture2D(u_outlineTexture, vec2(v_outlineCoordinates.x, 0.5)).r,\n";
    fragmentShader += "        max(\n";
    fragmentShader +=
      "          texture2D(u_outlineTexture, vec2(v_outlineCoordinates.y, 0.5)).r,\n";
    fragmentShader +=
      "          texture2D(u_outlineTexture, vec2(v_outlineCoordinates.z, 0.5)).r));\n";
    fragmentShader +=
      "    color = mix(color, vec3(0.0, 0.0, 0.0), outlineness);\n";
  }

  if (defined(alphaMode)) {
    if (alphaMode === "MASK") {
      fragmentShader += "    if (baseColorWithAlpha.a < u_alphaCutoff) {\n";
      fragmentShader += "        discard;\n";
      fragmentShader += "    }\n";
      fragmentShader += "    gl_FragColor = vec4(color, 1.0);\n";
    } else if (alphaMode === "BLEND") {
      fragmentShader +=
        "    gl_FragColor = vec4(color, baseColorWithAlpha.a);\n";
    } else {
      fragmentShader += "    gl_FragColor = vec4(color, 1.0);\n";
    }
  } else {
    fragmentShader += "    gl_FragColor = vec4(color, 1.0);\n";
  }


  if(isTrustGltf){
    fragmentShader += "if(u_enableTailorTiles){\n";
    fragmentShader += "  vec4 rectPos = u_inverTailorTilesCenterMat * u_currModelMatrix * vec4(v_stcVertex, 1.0);\n";
    fragmentShader += "  vec2 tuv = (rectPos.xy - u_tailorTilesRect.xy)/ u_tailorTilesRect.zw;\n";
    fragmentShader += "  vec4 tColor = texture2D(u_tailorTilesArea, tuv);\n";
    fragmentShader += "  if (!(tuv.x>=0.0 && tuv.x<=1.0 && tuv.y>=0.0 && tuv.y<=1.0) || (tColor.r<0.5 && tColor.a<0.5)) {\n";
    fragmentShader += "    discard;\n";
    fragmentShader += "  }\n";
    fragmentShader += "}\n";

    fragmentShader += "if(u_enableBrightTiles){\n";
    fragmentShader += "  vec4 rectPos = u_inverTailorTilesCenterMat * u_currModelMatrix * vec4(v_stcVertex, 1.0);\n";
    fragmentShader += "  vec2 tuv = (rectPos.xy - u_tailorTilesRect.xy)/ u_tailorTilesRect.zw;\n";
    fragmentShader += "  vec4 tColor = texture2D(u_tailorTilesArea, tuv);\n";
    fragmentShader += "  if (!(tuv.x>=0.0 && tuv.x<=1.0 && tuv.y>=0.0 && tuv.y<=1.0) || (tColor.r<0.5 && tColor.a<0.5)) {\n";
    fragmentShader += "    gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - u_contrast);\n";
    fragmentShader += "  } else {gl_FragColor.rgb = gl_FragColor.rgb * (1.0 + u_contrast);}\n";
    fragmentShader += "}\n";
}


  //�����ǿƼ�marsgis.cn�� ʷ͢��2019-11-20   ��Ĥ�Զ���
  //ʹ��ʵ�����ǻ۳��д���
  if(ExpandBySTC.styleBM&&ExpandBySTC.shaderOfBM && !isSelfGltfRes){
    fragmentShader += ExpandBySTC.shaderOfBM;
  }
  if (gltf.styleBM == "breath_lamp") {
    fragmentShader +=
    "gl_FragColor *= vec4(1.2);\n" +
    "float stc_a13 = fract(czm_frameNumber / 360.0);\n" +
    "float stc_h = clamp(abs(v_stcVertex.z) / 110.0, 0.0, 1.0);\n" +
    "stc_a13 = abs(stc_a13 - 0.5) * 2.0;\n" +
    "float stc_diff = step(0.005, abs(stc_h - stc_a13));\n" +
    "float stc_diff1 = step(0.005, abs(stc_h - stc_a13));\n" +
    "gl_FragColor.rgb += gl_FragColor.rgb * (1.0 - stc_diff);\n";
  } else if (gltf.styleBM == "interval_lines"){
    fragmentShader +=
    "gl_FragColor *= vec4(1.2);\n" +
    "float stc_a13 = fract(czm_frameNumber / 360.0);\n" +
    "float stc_h = fract(abs(v_stcVertex.z) / 50.0);\n" +
    "if(stc_h>0.05)return;\n" +
    "gl_FragColor.rgb += gl_FragColor.rgb * (1.0 - stc_h);\n";
  }
  
  //�����ǿƼ�marsgis.cn�� ʷ͢��2019-11-20   ��Ĥ�Զ���
  fragmentShader += "}\n";

  // Add shaders
  var vertexShaderId = addToArray(shaders, {
    type: WebGLConstants.VERTEX_SHADER,
    extras: {
      _pipeline: {
        source: vertexShader,
        extension: ".glsl",
      },
    },
  });

  var fragmentShaderId = addToArray(shaders, {
    type: WebGLConstants.FRAGMENT_SHADER,
    extras: {
      _pipeline: {
        source: fragmentShader,
        extension: ".glsl",
      },
    },
  });

  // Add program
  var programId = addToArray(programs, {
    fragmentShader: fragmentShaderId,
    vertexShader: vertexShaderId,
  });

  var techniqueId = addToArray(techniques, {
    attributes: techniqueAttributes,
    program: programId,
    uniforms: techniqueUniforms,
  });

  return techniqueId;
}

function getPBRValueType(paramName) {
  if (paramName.indexOf("Offset") !== -1) {
    return WebGLConstants.FLOAT_VEC2;
  } else if (paramName.indexOf("Rotation") !== -1) {
    return WebGLConstants.FLOAT;
  } else if (paramName.indexOf("Scale") !== -1) {
    return WebGLConstants.FLOAT_VEC2;
  } else if (paramName.indexOf("Texture") !== -1) {
    return WebGLConstants.SAMPLER_2D;
  }

  switch (paramName) {
    case "u_baseColorFactor":
      return WebGLConstants.FLOAT_VEC4;
    case "u_metallicFactor":
      return WebGLConstants.FLOAT;
    case "u_roughnessFactor":
      return WebGLConstants.FLOAT;
    case "u_emissiveFactor":
      return WebGLConstants.FLOAT_VEC3;
    // Specular Glossiness Types
    case "u_diffuseFactor":
      return WebGLConstants.FLOAT_VEC4;
    case "u_specularFactor":
      return WebGLConstants.FLOAT_VEC3;
    case "u_glossinessFactor":
      return WebGLConstants.FLOAT;
  }
}
export default processPbrMaterials;
