cmake_minimum_required(VERSION 3.26.0 FATAL_ERROR)

set(CMAKE_SYSTEM_VERSION 10.0 CACHE STRING "" FORCE)
set(CMAKE_CXX_STANDARD 20 CACHE STRING "The C++ standard to use")

set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Minimum OS X deployment version")
set(GAME_STR "MM")
project(2s2h VERSION 5.0.1 LANGUAGES C CXX)
include(CMake/2ship-cvars.cmake)
include(CMake/lus-cvars.cmake)
set(SPDLOG_LEVEL_TRACE 0)
set(SPDLOG_LEVEL_OFF 6)
# 2S2H [WASM] The browser build defaults to info; see the SPDLOG note in the Emscripten
# block below. A default only: -DSPDLOG_MIN_CUTOFF=... still wins on either platform.
if(EMSCRIPTEN)
    set(SPDLOG_MIN_CUTOFF SPDLOG_LEVEL_INFO CACHE STRING "cutoff at info")
else()
    set(SPDLOG_MIN_CUTOFF SPDLOG_LEVEL_TRACE CACHE STRING "cutoff at trace")
endif()
set(PROJECT_BUILD_NAME "Battler Bravo" CACHE STRING "" FORCE)
set(PROJECT_TEAM "github.com/harbourmasters" CACHE STRING "" FORCE)

execute_process(
    COMMAND git branch --show-current
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_BRANCH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

# Github Actions checks out a detached HEAD, so check environment for the branch name instead
if(NOT GIT_BRANCH)
    if(DEFINED ENV{GITHUB_HEAD_REF} AND NOT "$ENV{GITHUB_HEAD_REF}" STREQUAL "")
        set(GIT_BRANCH "$ENV{GITHUB_HEAD_REF}")
    elseif(DEFINED ENV{GITHUB_REF_NAME} AND NOT "$ENV{GITHUB_REF_NAME}" STREQUAL "")
        set(GIT_BRANCH "$ENV{GITHUB_REF_NAME}")
    else()
        set(GIT_BRANCH "detached")
    endif()
endif()

set(CMAKE_PROJECT_GIT_BRANCH "${GIT_BRANCH}" CACHE STRING "Git branch" FORCE)

execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_COMMIT_HASH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

# CI builds a PR from an ephemeral merge commit, so report the head commit GitHub shows instead
if(DEFINED ENV{GITHUB_EVENT_PATH} AND EXISTS "$ENV{GITHUB_EVENT_PATH}")
    file(READ "$ENV{GITHUB_EVENT_PATH}" GITHUB_EVENT_JSON)
    string(JSON PR_HEAD_SHA ERROR_VARIABLE PR_HEAD_SHA_ERROR GET "${GITHUB_EVENT_JSON}" "pull_request" "head" "sha")
    if(PR_HEAD_SHA AND PR_HEAD_SHA_ERROR STREQUAL "NOTFOUND")
        set(GIT_COMMIT_HASH "${PR_HEAD_SHA}")
    endif()
endif()

# Get only the first 7 characters of the hash
string(SUBSTRING "${GIT_COMMIT_HASH}" 0 7 SHORT_COMMIT_HASH)

set(CMAKE_PROJECT_GIT_COMMIT_HASH "${SHORT_COMMIT_HASH}" CACHE STRING "Git commit hash" FORCE)

execute_process(
    COMMAND git describe --tags --abbrev=0 --exact-match HEAD
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE GIT_COMMIT_TAG
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

if(NOT GIT_COMMIT_TAG)
    set(GIT_COMMIT_TAG "" CACHE STRING "Git commit tag" FORCE)
endif()

set(CMAKE_PROJECT_GIT_COMMIT_TAG "${GIT_COMMIT_TAG}" CACHE STRING "Git commit tag" FORCE)

set_property(DIRECTORY ${CMAKE_SOURCE_DIR} PROPERTY VS_STARTUP_PROJECT 2ship)

add_compile_options($<$<CXX_COMPILER_ID:MSVC>:/MP>)
add_compile_options($<$<CXX_COMPILER_ID:MSVC>:/utf-8>)

if (CMAKE_SYSTEM_NAME STREQUAL "Windows")
    if (CMAKE_C_COMPILER_LAUNCHER MATCHES "ccache|sccache")
        set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT Embedded)
    endif()
endif()

if (CMAKE_SYSTEM_NAME MATCHES "Windows|Linux")
    if(NOT DEFINED BUILD_CROWD_CONTROL)
        set(BUILD_CROWD_CONTROL OFF)
    endif()
endif()

# 2S2H [WASM] Provision dependencies from source; see CMake/emscripten-deps.cmake.
if(EMSCRIPTEN)
    include(CMake/emscripten-deps.cmake)

    # Emscripten ships official ports for these; they must be on the compile line as well
    # as the link line, since a port supplies its headers too. Applied globally so LUS and
    # 2ship agree -- mixing a port header with a host library is a silent-corruption bug.
    # libpng is for ColorPictograph, which writes the pictograph out as a .png.
    set(SHIP_EMSCRIPTEN_PORTS --use-port=sdl2 --use-port=ogg --use-port=vorbis --use-port=zlib
                              --use-port=libpng)
    add_compile_options(${SHIP_EMSCRIPTEN_PORTS})
    add_link_options(${SHIP_EMSCRIPTEN_PORTS})

    # The decomp and the port layer both throw; without this every throw aborts.
    add_compile_options(-fwasm-exceptions)
    add_link_options(-fwasm-exceptions)
    # ...and the exceptions ABI named explicitly, tree-wide, so every object and every
    # Emscripten port agrees on it. -fwasm-exceptions leaves it at the toolchain default,
    # which emsdk 6.0.9's libpng port script prints into its own flags as a Python bool,
    # `True`, and emcc rejects; as an integer it builds.
    add_compile_options(-sWASM_LEGACY_EXCEPTIONS=1)
    add_link_options(-sWASM_LEGACY_EXCEPTIONS=1)

    # Trace/debug logging is compiled out. Every spdlog call in a browser crosses into JS
    # and lands in the devtools console, which costs orders of magnitude more than writing
    # a line to a terminal -- resource loading alone emitted thousands of trace lines during
    # one boot of the sibling port. This is a performance fix, not a tidiness one. The
    # default is set near the top of this file, where the cache entry is first created;
    # FORCE here would override -D as well.

    # spdlog's bundled fmt uses consteval in a way this clang rejects. Same workaround the
    # macOS desktop build needs; harmless, it only relaxes a compile-time format check.
    add_compile_definitions(FMT_CONSTEVAL=constexpr)

    # LUS renders through its GLES3 path, which is WebGL2. Without this the GLES3 entry
    # points (glBlitFramebuffer, glReadBuffer, glRenderbufferStorageMultisample) do not
    # link, since Emscripten defaults to a WebGL1 target.
    add_link_options(-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2)

    # ...and the GLES3 path has to actually be switched on, or LUS generates desktop GLSL
    # and every shader fails to compile against the WebGL2 context. IMGUI_IMPL_OPENGL_ES3
    # is the same fix for ImGui's backend, which otherwise emits "#version 120".
    set(USE_OPENGLES ON)
    add_compile_definitions(IMGUI_IMPL_OPENGL_ES3)
endif()

# Enable the Gfx debugger in LUS to use libgfxd from ZAPDTR
# 2S2H [WASM] Off for the first pass: it is a debug aid, and every dependency we do not
# build is one less thing standing between here and a link.
if(EMSCRIPTEN)
    set(GFX_DEBUG_DISASSEMBLER OFF)
else()
    set(GFX_DEBUG_DISASSEMBLER ON)
endif()

# Tell LUS we're using F3DEX_GBI_2 (in a way that doesn't break libgfxd)
set(GBI_UCODE F3DEX_GBI_2)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/CMake")

# Enable MPQ and OTR support
set(INCLUDE_MPQ_SUPPORT ON)

################################################################################
# Set target arch type if empty. Visual studio solution generator provides it.
################################################################################
if (CMAKE_SYSTEM_NAME STREQUAL "Windows")
    if(NOT CMAKE_VS_PLATFORM_NAME)
        set(CMAKE_VS_PLATFORM_NAME "x64")
    endif()
    message("${CMAKE_VS_PLATFORM_NAME} architecture in use")

    if(NOT ("${CMAKE_VS_PLATFORM_NAME}" STREQUAL "x64"
        OR "${CMAKE_VS_PLATFORM_NAME}" STREQUAL "Win32"))
        message(FATAL_ERROR "${CMAKE_VS_PLATFORM_NAME} arch is not supported!")
    endif()
endif()

################################################################################
# VCPKG dependencies for Windows
################################################################################
if (CMAKE_SYSTEM_NAME STREQUAL "Windows")
include(CMake/automate-vcpkg.cmake)

if ("${CMAKE_VS_PLATFORM_NAME}" STREQUAL "Win32")
	set(VCPKG_TRIPLET x86-windows-static)
	set(VCPKG_TARGET_TRIPLET x86-windows-static)
elseif ("${CMAKE_VS_PLATFORM_NAME}" STREQUAL "x64")
	set(VCPKG_TRIPLET x64-windows-static)
	set(VCPKG_TARGET_TRIPLET x64-windows-static)
endif()

vcpkg_bootstrap()
vcpkg_install_packages(zlib bzip2 libzip libpng sdl2 sdl2-net glew glfw3 nlohmann-json tinyxml2 spdlog libogg libvorbis opus opusfile)
endif()

################################################################################
# Global configuration types
################################################################################
if (CMAKE_SYSTEM_NAME STREQUAL "NintendoSwitch")
    set(CMAKE_C_FLAGS_DEBUG "-g -ffast-math -DDEBUG")
    set(CMAKE_CXX_FLAGS_DEBUG "-g -ffast-math -DDEBUG")
    set(CMAKE_C_FLAGS_RELEASE "-O3 -ffast-math -DNDEBUG")
    set(CMAKE_CXX_FLAGS_RELEASE "-O3 -ffast-math -DNDEBUG")
elseif(MSVC)
    # We need to remove RTC1 as it is not compatible with O2, which we set for some files in DEBUG
    string(REGEX REPLACE "/RTC(su|[1su])" "" CMAKE_C_FLAGS_DEBUG "${CMAKE_C_FLAGS_DEBUG}")
    string(REGEX REPLACE "/RTC(su|[1su])" "" CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG}")
    set(CMAKE_C_FLAGS_RELEASE "/O2 /DNDEBUG")
    set(CMAKE_CXX_FLAGS_RELEASE "/O2 /DNDEBUG")
else()
    set(CMAKE_C_FLAGS_RELEASE "-O2 -DNDEBUG")
    set(CMAKE_CXX_FLAGS_RELEASE "-O2 -DNDEBUG")
    set(CMAKE_OBJCXX_FLAGS_RELEASE "-O2 -DNDEBUG")
endif()

if(NOT CMAKE_BUILD_TYPE )
    set(CMAKE_BUILD_TYPE "Debug" CACHE STRING "Choose the type of build." FORCE)
endif()

################################################################################
# Common utils
################################################################################
include(CMake/Utils.cmake)

if(CMAKE_SYSTEM_NAME MATCHES "Linux")
    get_linux_lsb_release_information()
    message(STATUS "Linux ${LSB_RELEASE_ID_SHORT} ${LSB_RELEASE_VERSION_SHORT} ${LSB_RELEASE_CODENAME_SHORT}")
else()
    message(STATUS ${CMAKE_SYSTEM_NAME})
endif()

################################################################################
# Additional Global Settings(add specific info there)
################################################################################
include(CMake/GlobalSettingsInclude.cmake OPTIONAL)

################################################################################
# Use solution folders feature
################################################################################
set_property(GLOBAL PROPERTY USE_FOLDERS ON)

################################################################################
# Set CONTROLLERBUTTONS_T
################################################################################
add_compile_definitions(CONTROLLERBUTTONS_T=uint32_t)

################################################################################
# Sub-projects
################################################################################
add_subdirectory(libultraship ${CMAKE_BINARY_DIR}/libultraship)
target_compile_definitions(libultraship PUBLIC INCLUDE_MPQ_SUPPORT)

# LUS ships no PCH of its own and these headers dominate its build. Done here rather than in the
# submodule, and PRIVATE, so nothing about its public interface changes.
if (CMAKE_CXX_COMPILER_ID MATCHES "Clang|AppleClang|GNU|MSVC")
    target_precompile_headers(libultraship PRIVATE
        "$<$<COMPILE_LANGUAGE:CXX>:<ship/Context.h$<ANGLE-R>>"
        "$<$<COMPILE_LANGUAGE:CXX>:<ship/resource/ResourceManager.h$<ANGLE-R>>"
        "$<$<COMPILE_LANGUAGE:CXX>:<ship/window/Window.h$<ANGLE-R>>"
        "$<$<COMPILE_LANGUAGE:CXX>:<spdlog/spdlog.h$<ANGLE-R>>"
    )
    # Clang replays a PCH's pending template instantiations in every consuming TU unless told to do
    # the work up front. MSVC's PCH already behaves this way.
    if (CMAKE_CXX_COMPILER_ID MATCHES "Clang|AppleClang")
        target_compile_options(libultraship PRIVATE
            $<$<COMPILE_LANGUAGE:CXX>:-fpch-instantiate-templates>
        )
    endif()
endif()

# 2S2H [WASM] ZAPD and OTRExporter are host tools that turn a ROM into .o2r archives. A
# wasm build consumes the archives someone else already produced, so they are not part of
# the cross build (see wasm-port.md, "Archives are provided, never extracted").
if(NOT EMSCRIPTEN)
    add_subdirectory(ZAPDTR/ZAPD ${CMAKE_BINARY_DIR}/ZAPD)
    add_subdirectory(OTRExporter)
endif()
add_subdirectory(mm)

if(NOT EMSCRIPTEN)
set_property(TARGET 2ship PROPERTY APPIMAGE_DESKTOP_FILE_TERMINAL YES)
set_property(TARGET 2ship PROPERTY APPIMAGE_DESKTOP_FILE "${CMAKE_SOURCE_DIR}/mm/linux/2s2h.desktop")
set_property(TARGET 2ship PROPERTY APPIMAGE_ICON_FILE "${CMAKE_BINARY_DIR}/2s2hIcon.png")
endif()

if("${CMAKE_SYSTEM_NAME}" STREQUAL "Linux")
install(FILES "${CMAKE_BINARY_DIR}/mm/2ship.o2r" DESTINATION . COMPONENT ship)
install(TARGETS ZAPD DESTINATION ./assets/extractor COMPONENT extractor)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/extractor/" DESTINATION ./assets/ COMPONENT extractor)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/xml/" DESTINATION ./assets/xml COMPONENT extractor)
endif()

if ("${CMAKE_SYSTEM_NAME}" STREQUAL "Windows")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/extractor/" DESTINATION ./assets/ COMPONENT 2s2h)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/xml/" DESTINATION ./assets/xml COMPONENT 2s2h)
endif()

find_package(Python3 COMPONENTS Interpreter)

# 2S2H [WASM] The asset-generation targets all shell out to ZAPD, which is not part of the
# cross build. Generate the .o2r archives with a desktop build and hand them to the wasm
# build instead.
if(NOT EMSCRIPTEN)

# Target to generate OTRs
add_custom_target(
    ExtractAssets
    # CMake versions prior to 3.17 do not have the rm command, use remove instead for older versions
    COMMAND ${CMAKE_COMMAND} -E $<IF:$<VERSION_LESS:${CMAKE_VERSION},3.17>,remove,rm> -f mm.zip 2ship.o2r
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/OTRExporter/extract_assets.py -z "$<TARGET_FILE:ZAPD>" --non-interactive --xml-root ../mm/assets/xml --custom-otr-file 2ship.o2r "--custom-assets-path" ${CMAKE_CURRENT_SOURCE_DIR}/mm/assets/custom --port-ver "${CMAKE_PROJECT_VERSION}"
    COMMAND ${CMAKE_COMMAND} -DSYSTEM_NAME=${CMAKE_SYSTEM_NAME} -DTARGET_DIR="$<TARGET_FILE_DIR:ZAPD>" -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR} -DBINARY_DIR=${CMAKE_BINARY_DIR} -P ${CMAKE_CURRENT_SOURCE_DIR}/CMake/copy-existing-otrs.cmake
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/mm
    COMMENT "Running asset extraction..."
    DEPENDS ZAPD
    BYPRODUCTS mm.o2r ${CMAKE_SOURCE_DIR}/mm.o2r ${CMAKE_SOURCE_DIR}/2ship.o2r
)

# Target to generate headers
add_custom_target(
    ExtractAssetHeaders
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/OTRExporter/extract_assets.py -z "$<TARGET_FILE:ZAPD>" --non-interactive --xml-root ../mm/assets/xml --gen-headers
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/mm
    COMMENT "Generating asset headers..."
    DEPENDS ZAPD
)

# Target to generate only 2ship.o2r
add_custom_target(
    Generate2ShipOtr
    # CMake versions prior to 3.17 do not have the rm command, use remove instead for older versions
    COMMAND ${CMAKE_COMMAND} -E $<IF:$<VERSION_LESS:${CMAKE_VERSION},3.17>,remove,rm> -f 2ship.o2r
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/OTRExporter/extract_assets.py -z "$<TARGET_FILE:ZAPD>" --norom --custom-otr-file 2ship.o2r "--custom-assets-path" ${CMAKE_CURRENT_SOURCE_DIR}/mm/assets/custom --port-ver "${CMAKE_PROJECT_VERSION}"
    COMMAND ${CMAKE_COMMAND} -DSYSTEM_NAME=${CMAKE_SYSTEM_NAME} -DTARGET_DIR="$<TARGET_FILE_DIR:ZAPD>" -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR} -DBINARY_DIR=${CMAKE_BINARY_DIR} -DONLY2SHIPOTR=On -P ${CMAKE_CURRENT_SOURCE_DIR}/CMake/copy-existing-otrs.cmake
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/mm
    COMMENT "Generating 2ship.o2r..."
    DEPENDS ZAPD
)

endif() # NOT EMSCRIPTEN

if(CMAKE_SYSTEM_NAME MATCHES "Linux")
file(COPY ${CMAKE_SOURCE_DIR}/mm/linux/2s2hIcon.png DESTINATION ${CMAKE_CURRENT_BINARY_DIR})
endif()

if(CMAKE_SYSTEM_NAME MATCHES "Darwin")
add_custom_target(CreateOSXIcons
   COMMAND mkdir -p ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset
   COMMAND sips -z 16 16     mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_16x16.png
   COMMAND sips -z 32 32     mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_16x16@2x.png
   COMMAND sips -z 32 32     mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_32x32.png
   COMMAND sips -z 64 64     mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_32x32@2x.png
   COMMAND sips -z 128 128   mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_128x128.png
   COMMAND sips -z 256 256   mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_128x128@2x.png
   COMMAND sips -z 256 256   mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_256x256.png
   COMMAND sips -z 512 512   mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_256x256@2x.png
   COMMAND sips -z 512 512   mm/macosx/2s2hIcon.png --out ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_512x512.png
   COMMAND cp                mm/macosx/2s2hIcon.png ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset/icon_512x512@2x.png
   COMMAND iconutil -c icns -o ${CMAKE_BINARY_DIR}/macosx/2s2h.icns ${CMAKE_BINARY_DIR}/macosx/2s2h.iconset
   WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
   COMMENT "Creating OSX icons ..."
   )
add_dependencies(2ship CreateOSXIcons)

install(TARGETS ZAPD DESTINATION ${CMAKE_BINARY_DIR}/assets/extractor)

set(PROGRAM_PERMISSIONS_EXECUTE OWNER_EXECUTE OWNER_WRITE OWNER_READ GROUP_EXECUTE GROUP_READ WORLD_EXECUTE WORLD_READ)

install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/extractor/" DESTINATION ./assets/)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/mm/assets/xml/" DESTINATION ./assets/xml)

# Rename the installed soh binary to drop the macos suffix
INSTALL(CODE "FILE(RENAME \${CMAKE_INSTALL_PREFIX}/../MacOS/2s2h-macos \${CMAKE_INSTALL_PREFIX}/../MacOS/2s2h)")
install(CODE "
   include(BundleUtilities)
  fixup_bundle(\"\${CMAKE_INSTALL_PREFIX}/../MacOS/2s2h\" \"\" \"${dirs}\")
   ")

endif()

if(CMAKE_SYSTEM_NAME MATCHES "Windows|NintendoSwitch|CafeOS")
install(FILES ${CMAKE_SOURCE_DIR}/README.md DESTINATION . COMPONENT 2s2h RENAME readme.txt )
install(CODE "file(MAKE_DIRECTORY \"\${CMAKE_INSTALL_PREFIX}/mods\")" COMPONENT 2s2h)
install(CODE "file(TOUCH \"\${CMAKE_INSTALL_PREFIX}/mods/custom_mod_files_go_here.txt\")" COMPONENT 2s2h)
endif()

if(CMAKE_SYSTEM_NAME MATCHES "Linux")
    set(CPACK_GENERATOR "External")
elseif(CMAKE_SYSTEM_NAME MATCHES "Windows|NintendoSwitch|CafeOS")
    set(CPACK_GENERATOR "ZIP")
elseif(CMAKE_SYSTEM_NAME MATCHES "Darwin")
    set(CPACK_GENERATOR "Bundle")
endif()

set(CPACK_PROJECT_CONFIG_FILE ${CMAKE_SOURCE_DIR}/CMake/Packaging-2.cmake)
include(CMake/Packaging.cmake)
