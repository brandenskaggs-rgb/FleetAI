"""Render the approved Link mark as a compact, scroll-driven Blender sequence.

Run with Blender --background --python tools/render-brand-motion.py.
Source renders stay outside the site. Publish optimized frames with FFmpeg.
"""
import math
import os
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('FLEET_BRAND_RENDER_DIR', str(ROOT / 'tmp' / 'brand-motion')))
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.view_settings.view_transform = 'AgX'
scene.world.color = (.4, .4, .4)

def material(name, color, metal):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metal
    shader.inputs['Roughness'].default_value = .28
    return result

blue = material('Fleet graphite / satin', (.015, .021, .024), .28)
silver = material('Precision aluminum', (.68, .72, .78), .65)
parts = [
    [(0,.24),(0,.78),(.22,1),(.76,1),(.76,.76),(.31,.76),(.24,.69),(.24,.24)],
    [(.24,0),(.78,0),(1,.22),(1,.76),(.76,.76),(.76,.31),(.69,.24),(.24,.24)],
]
objects=[]
for index, points in enumerate(parts):
    mesh=bpy.data.meshes.new('Link silhouette')
    mesh.from_pydata([((x-.5)*4,(y-.5)*4,0) for x,y in points],[],[list(range(len(points)))])
    mesh.update()
    obj=bpy.data.objects.new('Link / '+('vehicle signals' if index==0 else 'maintenance decisions'),mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(blue if index==0 else silver)
    solid=obj.modifiers.new('Machined depth','SOLIDIFY')
    solid.thickness=.24
    bevel=obj.modifiers.new('Edge highlight','BEVEL')
    bevel.width=.035
    bevel.segments=3
    obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    objects.append(obj)

def area(name,location,power,size):
    data=bpy.data.lights.new(name,'AREA')
    data.energy=power
    data.shape='DISK'
    data.size=size
    obj=bpy.data.objects.new(name,data)
    scene.collection.objects.link(obj)
    obj.location=location
    obj.rotation_euler=(Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()

area('Large softbox',(-3,4,7),1000,5)
area('Rim',(5,-1,4),850,4)
camera=bpy.data.cameras.new('Brand camera')
camera.type='ORTHO'
camera.ortho_scale=7.2
cam=bpy.data.objects.new('Brand camera',camera)
scene.collection.objects.link(cam)
cam.location=(0,0,12)
scene.camera=cam
scene.frame_start=1
scene.frame_end=48
for frame in range(1,49):
    t=(frame-1)/47
    eased=t*t*(3-2*t)
    for i,obj in enumerate(objects):
        direction=-1 if i==0 else 1
        obj.location=(direction*(1-eased)*.78,direction*(1-eased)*-.28,0)
        obj.rotation_euler=(math.radians(12*(1-eased)),math.radians(-24*(1-eased)),math.radians(direction*17*(1-eased)))
        obj.keyframe_insert(data_path='location',frame=frame)
        obj.keyframe_insert(data_path='rotation_euler',frame=frame)
    scene.frame_set(frame)
    scene.render.filepath=str(OUT/f'link-{frame:03d}.png')
    bpy.ops.render.render(write_still=True)
scene.frame_set(48)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'Fleet-AI-Link-Motion.blend'))
print('Brand motion render complete:',OUT)
