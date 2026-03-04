// ==UserScript==
// @name         Sketchfab Model Ripper Refactored
// @version      2.0.0
// @description  Извлечение 3D моделей и текстур из Sketchfab Viewer
// @author       Risk (Refactored by Gemini)
// @include      /^https?://(www\.)?sketchfab\.com/.*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip-utils/0.0.2/jszip-utils.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // --- Глобальные настройки и хранилища ---
    const win = unsafeWindow;
    const zip = new JSZip();
    const folder = zip.folder('collection');
    
    // Хранилища для перехваченных данных
    win.allmodel = [];      // Список моделей (геометрия)
    const textureCache = {}; // Кеш для URL текстур
    const texturesToSave = new Set();
    const zipFiles = {};     // Объекты для финального архива
    
    let isButtonAdded = false;

    // --- Регулярные выражения для патчинга оригинального JS Sketchfab ---
    // Эти выражения ищут точки входа в минимизированном коде движка
    const PATCH_RULES = {
        drawGeometry: /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g,
        drawArrays: /t\.drawArrays\(t\.TRIANGLES,0,6\)/g,
        renderInto1: /A\.renderInto\(n,E,R/g, // Актуально на 2023-2026
        renderInto2: /g\.renderInto=function\(e,i,r/g,
        getResourceImage: /getResourceImage:function\(e,t\){/g
    };

    const MODEL_SCALE = 0.01

    console.log("[Ripper] Скрипт запущен. Ожидание загрузки ресурсов...");

    /**
     * Создает кнопку скачивания в интерфейсе Sketchfab
     */
    const injectDownloadButton = () => {
        if (isButtonAdded) return;

        // Ищем панель заголовка через XPath
        const titleBar = document.evaluate("//div[@class='titlebar']", document, null, 9, null).singleNodeValue;

        if (titleBar) {
            console.log("[Ripper] Панель найдена. Добавляю кнопку...");
            const btn = document.createElement("a");
            btn.className = "control";
            btn.innerHTML = "<pre style='color: #ff4444; font-weight: bold; cursor: pointer;'>DOWNLOAD</pre>";
            btn.addEventListener("click", startDownloadProcess);
            titleBar.appendChild(btn);
            isButtonAdded = true;
        } else {
            // Если панель еще не прогрузилась, пробуем снова через 3 сек
            setTimeout(injectDownloadButton, 3000);
        }
    };

    /**
     * Основной процесс сборки файлов и скачивания
     */
    const startDownloadProcess = () => {
        console.log("[Ripper] Сборка модели началась...");
        
        if (win.allmodel.length === 0) {
            alert("Модели не найдены. Попробуйте покрутить модель в просмотрщике.");
            return;
        }

        if (texturesToSave.size > 0 && !confirm(`Не все текстуры были распознаны:\n${[...texturesToSave].join('\n')}\n\nСкачать все равно?`)) return

        const geometryNames = new Set()
        const materialNames = new Set()
        win.allmodel.forEach((modelData) => {
            const geometryName = getUniqueName(getGeometryName(modelData), geometryNames);
            const materialName = getUniqueName(getMaterialName(modelData), materialNames);
            geometryNames.add(geometryName);
            materialNames.add(materialName);
            console.log(`[Ripper] Обработка части: ${geometryName}`);
            
            const parsedMaterialData = parseMaterial(modelData);
            createMtlFile(materialName, parsedMaterialData);

            const parsedGeometryData = parseGeometry(modelData);
            createObjFile(geometryName, materialName, parsedGeometryData);
        });

        packAndSave();
    };

    const getGeometryName = (data) => {
        return data?._geometry?._name || data?._parents[0]?._name || data?._name || 'model'
    }

    const getMaterialName = (data) => {
        return data?.stateset?._name || data?._parents[0]?._name || 'material'
    }

    const getUniqueName = (baseName, names = new Set()) => {
        let uniqueName = baseName;
        let counter = 1;
        while (names.has(uniqueName)) {
            uniqueName = `${baseName}_${counter}`;
            counter++;
        }
        return uniqueName
    }

    const parseMaterial = (data) => {
        const channels = (data?.stateset || data._parents[0]?.stateset)?._attributeArray[0]?._object?._activeChannels || []
        return { channels: channels.map(c => {
            const attr = c.attributes;
            const url = attr.textureModel?.attributes?.multiresTexture?._image?._url
            return {
                name: attr.name,
                texture: url && textureCache[url].name,
                factor: attr.factor !== undefined ? attr.factor : 1.0,
                color: attr.color,
                enable: attr.enable
            }
        })}
    };

    const createMtlFile = (name, data) => {
        const channels = data.channels;
        let mtl = `newmtl ${name}\n`;

        channels.filter(c => c.enable).forEach(c => {
            const { texture, factor, color } = c;
            switch (c.name) {
                case 'DiffuseColor':
                case 'DiffuseIntensity':
                case 'AlbedoPBR':
                case 'DiffusePBR': {
                    // Если есть цвет — берем его, если только фактор — делаем серый, иначе белый
                    const f = (factor !== undefined) ? factor : 1.0;
                    if (color) {
                        const r = color[0] * f;
                        const g = color[1] * f;
                        const b = color[2] * f;
                        mtl += `Kd ${r} ${g} ${b}\n`;
                    } else {
                        // Если цвета нет, просто используем фактор как серый цвет
                        mtl += `Kd ${f} ${f} ${f}\n`;
                    }
                    if (texture) mtl += `map_Kd ${texture}\n`;
                    break;
                }
                case 'SpecularColor':
                case 'SpecularF0':
                case 'SpecularPBR': {
                    // SpecularPBR может быть цветным, SpecularF0 обычно просто число
                    const f = (factor !== undefined) ? factor : 1.0;
                    if (color) {
                        const r = color[0] * f;
                        const g = color[1] * f;
                        const b = color[2] * f;
                        mtl += `Ks ${r} ${g} ${b}\n`;
                    } else {
                        // Если цвета нет, просто используем фактор как серый цвет
                        mtl += `Ks ${f} ${f} ${f}\n`;
                    }
                    if (texture) mtl += `map_Ks ${texture}\n`;
                    break;
                }
                case 'SpecularHardness':
                    // Ns в MTL обычно варьируется от 0 до 1000
                    // Если factor прилетает в диапазоне 0-1, его часто умножают на 100
                    const nsValue = (factor <= 1.0) ? factor * 100 : factor;
                    mtl += `Ns ${nsValue}\n`;
                    break;
                case 'MetalnessPBR':
                    mtl += `Pm ${factor}\n`; // Интенсивность металла
                    if (texture) mtl += `map_Pm ${texture}\n`;
                    break;
            
                case 'RoughnessPBR':
                    mtl += `Pr ${factor}\n`; // Интенсивность шероховатости
                    if (texture) mtl += `map_Pr ${texture}\n`;
                    break;

                case 'GlossinessPBR':
                    mtl += `Ps ${factor}\n`;
                    if (texture) mtl += `map_Ps ${texture}\n`;
                    break;

                case 'SheenPBR':
                    mtl += `Psh ${factor}\n`;
                    if (texture) mtl += `map_Psh ${texture}\n`;
                    break;

                case 'SheenRoughnessPBR':
                    mtl += `Pshr ${factor}\n`;
                    break;
            
                case 'EmitColor':
                case 'EmissivePBR': {
                    const f = (factor !== undefined) ? factor : 1.0;
                    if (color) {
                        const r = color[0] * f;
                        const g = color[1] * f;
                        const b = color[2] * f;
                        mtl += `Ke ${r} ${g} ${b}\n`;
                    } else {
                        // Если цвета нет, просто используем фактор как серый цвет
                        mtl += `Ke ${f} ${f} ${f}\n`;
                    }
                    if (texture) mtl += `map_Ke ${texture}\n`;
                    break;
                }
                case 'AlphaMask':
                case 'Opacity':
                case 'OpacityPBR':
                case 'Transparency':
                    mtl += `d ${factor}\n`; // 1.0 - полностью непрозрачный
                    if (texture) mtl += `map_d ${texture}\n`;
                    break;
                
                case 'ClearcoatPBR':
                    mtl += `Pc ${factor}\n`;
                    if (texture) mtl += `map_Pc ${texture}\n`;
                    break;

                case 'ClearcoatRoughnessPBR':
                    mtl += `Pcr ${factor}\n`;
                    if (texture) mtl += `map_Pcr ${texture}\n`;
                    break;

                case 'HeightMap':
                case 'DisplacementPBR': {
                    if (texture) {
                        const hF = factor ?? 1.0;
                        mtl += `disp -bm ${hF} ${texture}\n`;
                    } else {
                        console.warn(`[Ripper] Нет карты высот для материала "${name}"`);
                        alert(`[Ripper] Нет карты высот для материала "${name}"`)
                    }
                    break;
                }
            
                case 'NormalMap':
                case 'BumpMap': {
                    if (texture) {
                        const nF = (factor !== undefined) ? factor : 1.0;
                        mtl += `map_Bump -bm ${nF} ${texture}\n`;
                    } else {
                        console.warn(`[Ripper] Нет карты нормалей для материала "${name}"`);
                        alert(`[Ripper] Нет карты нормалей для материала "${name}"`)
                    }
                    break;
                }
        
                case 'AOPBR': {
                    if (texture) {
                        mtl += `map_Ka ${texture}\n`;
                    } else {
                        console.warn(`[Ripper] Нет карты AO для материала "${name}"`);
                        alert(`[Ripper] Нет карты AO для материала "${name}"`)
                    }
                    break;
                }

                default: {
                    console.warn(`[Ripper] Неизвестный канал "${c.name}" для материала "${name}"`);
                    alert(`[Ripper] Неизвестный канал "${c.name}" для материала "${name}"`);
                }
            }
        });

        if (mtl.includes('undefined')) {
            alert(`[Ripper] Некорректные данные для материала "${name}":\n${mtl}`);
            throw new Error(`[Ripper] Некорректные данные для материала "${name}"`);
        }

        zipFiles[`${name}.mtl`] = new Blob([mtl], { type: 'text/plain' });
        console.log(`[Ripper] MTL файл создан: ${name}.mtl`);
    };

    /**
     * Парсинг сырых данных геометрии Sketchfab в удобный формат
     */
    const parseGeometry = (data) => {
        const primitives = [];
        data._primitives.forEach(p => {
            if (p && p.indices) {
                primitives.push({
                    mode: p.mode,
                    indices: p.indices._elements
                });
            }
        });

        const attr = data._attributes;
        return {
            vertex: attr.Vertex._elements,
            normal: attr.Normal ? attr.Normal._elements : [],
            uv: extractUV(attr),
            primitives: primitives
        };
    };

    /**
     * Поиск доступных UV-координат (проверяет слоты от 0 до 8)
     */
    const extractUV = (attr) => {
        for (let i = 0; i <= 8; i++) {
            const key = `TexCoord${i}`;
            if (attr[key]) return attr[key]._elements;
        }
        return [];
    };

    /**
     * Конвертация геометрии в формат .OBJ
     */
    const createObjFile = (name, materialName, data) => {
        let objContent = `mtllib ${materialName}.mtl\no ${name}\n`;

        // Вершины (v x y z)
        for (let i = 0; i < data.vertex.length; i += 3) {
            objContent += `v ${data.vertex[i] * MODEL_SCALE} ${data.vertex[i+1] * MODEL_SCALE} ${data.vertex[i+2] * MODEL_SCALE}\n`;
        }

        // Нормали (vn x y z)
        for (let i = 0; i < data.normal.length; i += 3) {
            objContent += `vn ${data.normal[i]} ${data.normal[i+1]} ${data.normal[i+2]}\n`;
        }

        // UV-координаты (vt u v)
        for (let i = 0; i < data.uv.length; i += 2) {
            objContent += `vt ${data.uv[i]} ${data.uv[i+1]}\n`;
        }

        objContent += 's on\n';
        objContent += `usemtl ${materialName}\n`;

        const hasNormals = data.normal.length > 0;
        const hasUV = data.uv.length > 0;

        // Грани (f v/vt/vn)
        data.primitives.forEach(prim => {
            if (prim.mode === 4 || prim.mode === 5) { // TRIANGLES или TRIANGLE_STRIP
                const isStrip = (prim.mode === 5);
                for (let j = 0; j + 2 < prim.indices.length; !isStrip ? j += 3 : j++) {
                    let order = [0, 1, 2];
                    if (isStrip && (j % 2 === 1)) order = [0, 2, 1];

                    let faceLine = 'f ';
                    order.forEach(k => {
                        const idx = prim.indices[j + k] + 1;
                        faceLine += idx;
                        if (hasUV || hasNormals) {
                            faceLine += '/';
                            if (hasUV) faceLine += idx;
                            if (hasNormals) faceLine += '/' + idx;
                        }
                        faceLine += ' ';
                    });
                    objContent += faceLine + '\n';
                }
            }
        });

        zipFiles[`${name}.obj`] = new Blob([objContent], { type: 'text/plain' });
        console.log(`[Ripper] OBJ файл создан: ${name}.obj`);
    };

    /**
     * Финальная упаковка всех файлов в ZIP
     */
    const packAndSave = () => {
        console.log("[Ripper] Формирование ZIP-архива...");
        
        Object.keys(zipFiles).forEach(fileName => {
            folder.file(fileName, zipFiles[fileName], { binary: true });
        });

        // Пытаемся взять имя модели со страницы
        const modelNameLabel = document.getElementsByClassName('model-name__label')[0];
        const zipName = (modelNameLabel ? modelNameLabel.textContent : 'sketchfab_model') + ".zip";

        folder.generateAsync({ type: "blob" }).then(content => {
            saveAs(content, zipName);
            console.log(`[Ripper] Успешно сохранено: ${zipName}`);
        });
    };

    // --- Функции-хуки (вызываются из пропатченного кода Sketchfab) ---

    win.attachbody = (obj) => {
        // Фильтруем ненужные объекты (земля, служебные слои)
        if (!obj._faked && (obj._name || (obj.stateset && obj.stateset._name) || (obj._parents && obj._parents[0]._name))) {
            if (obj._name === "composer layer" || obj._name === "Ground - Geometry") return;
            
            obj._faked = true; // Метка, чтобы не дублировать
            win.allmodel.push(obj);
            console.log(`[Ripper] Захвачена геометрия: ${getGeometryName(obj)}`, obj);
        }
    };

    win.drawhookcanvas = (imgData, imageModel) => {
        if (!imageModel) return imgData;
        
        const attributes = imageModel.attributes;
        const fileName = attributes.name;
        
        if (!textureCache[imgData.url]) {
            const name = fileName.replace(/\.(png|jpg|jpeg)$/i, '') + ".png"
            textureCache[imgData.url] = { name, origName: fileName, width: imgData.width, height: imgData.height };
            texturesToSave.add(name)
            console.log(`[Ripper] Найдена текстура: ${fileName} (${imgData.width}x${imgData.height})`);
            console.log(`[Ripper] URL: ${imgData.url}`);
        }
        return imgData;
    };

    win.drawhookimg = (gl, textureInfo) => {
        const url = textureInfo[5].currentSrc;
        if (!textureCache[url]) {
            console.log(`[Ripper] Текстура не распознана: ${url} (${textureInfo[5].width}x${textureInfo[5].height})`);
            return;
        }
        const { name, width, height } = textureCache[url]

        // Проверяем, что нет такой же текстуры, но с большим размером
        if (Object.values(textureCache).some(t => t.name === name && t.width > width)) return;

        const data = new Uint8Array(width * height * 4);
        
        // Читаем пиксели прямо из WebGL контекста
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);

        // WebGL читает снизу вверх, нужно перевернуть изображение по вертикали
        const halfHeight = (height / 2) | 0;
        const bytesPerRow = width * 4;
        const tempRow = new Uint8Array(bytesPerRow);

        for (let y = 0; y < halfHeight; ++y) {
            const top = y * bytesPerRow;
            const bottom = (height - y - 1) * bytesPerRow;
            tempRow.set(data.subarray(top, top + bytesPerRow));
            data.copyWithin(top, bottom, bottom + bytesPerRow);
            data.set(tempRow, bottom);
        }

        // Рисуем на временный canvas для получения PNG
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        imgData.data.set(data);
        ctx.putImageData(imgData, 0, 0);
        
        canvas.toBlob(blob => {
            zipFiles[name] = blob;
            texturesToSave.delete(name);
            console.log(`[Ripper] Текстура готова к упаковке: ${name} (${width}x${height})`);
        }, "image/png");
    };

    // --- Система перехвата скриптов (Injection Engine) ---

    const setupScriptInterception = () => {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.tagName === "SCRIPT" && node.src) {
                        const isViewerScript = node.src.includes("web/dist/") || node.src.includes("standaloneViewer");
                        
                        if (isViewerScript) {
                            console.log(`[Ripper] Перехват скрипта: ${node.src}`);
                            applyPatchesToScript(node);
                        }
                    }
                }
            }
        });

        observer.observe(document, { childList: true, subtree: true });
    };

    const applyPatchesToScript = (scriptNode) => {
        // Останавливаем оригинальный скрипт
        const originalSrc = scriptNode.src;
        scriptNode.type = 'text/ignored'; 
        
        // Загружаем его вручную
        const xhr = new XMLHttpRequest();
        xhr.open('GET', originalSrc, false); // Синхронно, чтобы не нарушить порядок загрузки
        xhr.send('');

        let jsCode = xhr.responseText;

        // Применяем патчи через замену строк
        // Patch 0 & 1: Инъекция переменных для данных изображений
        if (PATCH_RULES.renderInto1.test(jsCode)) {
            jsCode = jsCode.replace(PATCH_RULES.renderInto1, (match) => match + ",i");
            console.log("[Ripper] Патч 0 (renderInto) применен");
        }

        if (PATCH_RULES.renderInto2.test(jsCode)) {
            jsCode = jsCode.replace(PATCH_RULES.renderInto2, (match) => match + ",image_data");
            console.log("[Ripper] Патч 1 (image_data) применен");
        }

        // Patch 2: Хук на отрисовку текстур
        if (PATCH_RULES.drawArrays.test(jsCode)) {
            jsCode = jsCode.replace(PATCH_RULES.drawArrays, (match) => match + ",window.drawhookimg(t,image_data)");
            console.log("[Ripper] Патч 2 (drawhookimg) применен");
        }

        // Patch 3: Хук на получение ресурсов (Canvas)
        if (PATCH_RULES.getResourceImage.test(jsCode)) {
            jsCode = jsCode.replace(PATCH_RULES.getResourceImage, (match) => match + "e = window.drawhookcanvas(e,this._imageModel);");
            console.log("[Ripper] Патч 3 (drawhookcanvas) применен");
        }

        // Patch 4: Хук на захват геометрии
        if (PATCH_RULES.drawGeometry.test(jsCode)) {
            jsCode = jsCode.replace(PATCH_RULES.drawGeometry, (match) => match + ";window.attachbody(t);");
            console.log("[Ripper] Патч 4 (attachbody) применен");
            setTimeout(injectDownloadButton, 3000);
        }

        // Создаем новый скрипт с модифицированным кодом
        const patchedScript = document.createElement('script');
        patchedScript.type = "text/javascript";
        patchedScript.text = jsCode;
        document.head.appendChild(patchedScript);
    };

    setupScriptInterception();

})();