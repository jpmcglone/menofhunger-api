import { Body, Controller, Delete, Get, Req, Param, Post, Patch, Query, UseGuards } from "@nestjs/common";
import { AdminGuard, type AdminRequest } from "./admin.guard";
import { AdminUsersService } from './admin-users.service';

@UseGuards(AdminGuard)
@Controller("admin/users")
export class AdminUsersController {
  constructor(
    private readonly adminUsers: AdminUsersService,
  ) {}

  @Get("banned")
  listBanned(@Query() query: unknown) {
    return this.adminUsers.listBanned(query);
  }

  @Get("search")
  search(@Query() query: unknown) {
    return this.adminUsers.search(query);
  }

  @Get("username/available")
  usernameAvailable(@Query() query: unknown) {
    return this.adminUsers.usernameAvailable(query);
  }

  @Post(":id/ban")
  ban(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.adminUsers.ban(req, id, body);
  }

  @Post(":id/unban")
  unban(@Param("id") id: string) {
    return this.adminUsers.unban(id);
  }

  @Get(":id")
  getUser(@Param("id") id: string) {
    return this.adminUsers.getUser(id);
  }

  @Get("by-username/:username")
  getUserByUsername(@Param() params: unknown) {
    return this.adminUsers.getUserByUsername(params);
  }

  @Post("by-username/:username/reveal-sensitive")
  revealSensitiveByUsername(@Param() params: unknown) {
    return this.adminUsers.revealSensitiveByUsername(params);
  }

  @Get("by-username/:username/recent/posts")
  recentPostsByUsername(@Param() params: unknown, @Query() query: unknown) {
    return this.adminUsers.recentPostsByUsername(params, query);
  }

  @Get("by-username/:username/recent/articles")
  recentArticlesByUsername(@Param() params: unknown, @Query() query: unknown) {
    return this.adminUsers.recentArticlesByUsername(params, query);
  }

  @Get("by-username/:username/recent/searches")
  recentSearchesByUsername(@Param() params: unknown, @Query() query: unknown) {
    return this.adminUsers.recentSearchesByUsername(params, query);
  }

  @Patch(":id/profile")
  updateUser(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AdminRequest,
  ) {
    return this.adminUsers.updateUser(id, body, req);
  }

  @Post(":id/uploads/avatar/init")
  adminInitAvatar(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.adminInitAvatar(id, body);
  }

  @Post(":id/uploads/avatar/commit")
  adminCommitAvatar(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.adminCommitAvatar(id, body);
  }

  @Delete(":id/uploads/avatar")
  adminDeleteAvatar(@Param("id") id: string) {
    return this.adminUsers.adminDeleteAvatar(id);
  }

  @Post(":id/uploads/banner/init")
  adminInitBanner(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.adminInitBanner(id, body);
  }

  @Post(":id/uploads/banner/commit")
  adminCommitBanner(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.adminCommitBanner(id, body);
  }

  @Delete(":id/uploads/banner")
  adminDeleteBanner(@Param("id") id: string) {
    return this.adminUsers.adminDeleteBanner(id);
  }

  @Post(":id/coins/adjust")
  adjustCoins(
    @Req() req: AdminRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.adminUsers.adjustCoins(req, id, body);
  }

  @Get(":id/orgs")
  listOrgMemberships(@Param("id") id: string) {
    return this.adminUsers.listOrgMemberships(id);
  }

  @Post(":id/orgs")
  addOrgMembership(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.addOrgMembership(id, body);
  }

  @Delete(":id/orgs/:orgId")
  removeOrgMembership(@Param("id") id: string, @Param("orgId") orgId: string) {
    return this.adminUsers.removeOrgMembership(id, orgId);
  }

  @Post(":id/convert-to-page")
  convertToPage(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.convertToPage(id, body);
  }

  @Get(":id/operators")
  listOperators(@Param("id") id: string) {
    return this.adminUsers.listOperators(id);
  }

  @Post(":id/operators")
  addOperator(@Param("id") id: string, @Body() body: unknown) {
    return this.adminUsers.addOperator(id, body);
  }

  @Delete(":id/operators/:operatorUserId")
  removeOperator(
    @Param("id") id: string,
    @Param("operatorUserId") operatorUserId: string,
  ) {
    return this.adminUsers.removeOperator(id, operatorUserId);
  }

  @Get(":id/operated-pages")
  listOperatedPages(@Param("id") id: string) {
    return this.adminUsers.listOperatedPages(id);
  }

  @Post(":id/email/unverify")
  unverifyEmail(@Param("id") id: string) {
    return this.adminUsers.unverifyEmail(id);
  }
}
