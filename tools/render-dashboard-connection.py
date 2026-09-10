"""Build Fleet AI's connection illustration in a fresh Blender process."""
import os
from pathlib import Path
import bpy
from mathutils import Vector

out = Path(os.environ['FLEET_BRAND_RENDER_DIR'])
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1000
scene.render.resolution_y = 740
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.view_settings.view_transform = 'AgX'

def material(name, color, metallic=0):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    node = result.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = (*color, 1)
    node.inputs['Metallic'].default_value = metallic
    node.inputs['Roughness'].default_value = .32
    return result

graphite = material('Fleet AI graphite', (.021, .032, .035), .35)
glass = material('Display', (.055, .08, .085), .1)
silver = material('Machined silver', (.7, .75, .76), .7)
white = material('Link white', (.93, .96, .96))

def block(name, location, scale, surface, bevel=.08):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(surface)
    edge = obj.modifiers.new('Milled edges', 'BEVEL')
    edge.width = bevel
    edge.segments = 4
    obj.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
    return obj

block('Tablet chassis', (0, .6, 0), (3.5, 4.5, .26), graphite, .15)
block('Tablet screen', (0, .6, .15), (3.13, 3.96, .025), glass, .06)
block('Camera lens', (0, 2.7, .16), (.07, .07, .02), silver, .025)
points = [(-1, -.52), (-1, .56), (-.56, 1), (.52, 1), (.52, .52), (-.38, .52), (-.52, .38), (-.52, -.52)]
for i in range(2):
    sign = 1 if i == 0 else -1
    vertices = [(sign*x*.72, .72+sign*y*.72, .2) for x, y in points]
    mesh = bpy.data.meshes.new(f'Link half {i}')
    mesh.from_pydata(vertices, [], [list(range(len(vertices)))])
    mesh.update()
    obj = bpy.data.objects.new(f'Link half {i}', mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(white)
for i, width in enumerate([1.85, 1.4, 1.1]):
    block(f'Display record {i}', (-.1, -.62-i*.25, .2), (width, .04, .025), silver, .008)
block('Connection module', (1.4, -2.45, .28), (2, 1.1, .56), graphite, .07)
block('Module face', (1.4, -2.45, .58), (1.6, .65, .03), silver, .03)
for i in range(3):
    block(f'Link indicator {i}', (.98+i*.36, -2.45, .61), (.18, .18, .035), graphite, .01)

for name, location, energy, size in [('Key', (-4, 4, 8), 1100, 5), ('Rim', (5, -2, 6), 950, 4)]:
    lamp = bpy.data.lights.new(name, 'AREA')
    lamp.energy, lamp.shape, lamp.size = energy, 'DISK', size
    obj = bpy.data.objects.new(name, lamp)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((0, 0, 0))-obj.location).to_track_quat('-Z', 'Y').to_euler()
camera = bpy.data.cameras.new('Connection camera')
camera.type, camera.ortho_scale = 'ORTHO', 8.6
obj = bpy.data.objects.new('Connection camera', camera)
scene.collection.objects.link(obj)
obj.location = (5, -6, 12)
obj.rotation_euler = (Vector((0, 0, 0))-obj.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = obj
scene.render.filepath = str(out/'fleetai-connection.png')
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'Fleet-AI-Connection.blend'))
